require('dotenv').config();
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const supabase = require('./supabase.js');

const INSTANCE_ID = process.env.INSTANCE_ID || 1;
const RECONCILE_INTERVAL_MS = 60000;
const POLLING_INTERVAL_BASE_MS = 20000;
const RECONNECT_DELAY_MS = 30000;

const managedMailboxes = new Map();

function log(level, message, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    instanceId: INSTANCE_ID,
    ...details,
    message,
  }));
}

class MailboxManager {
  constructor(credentials) {
    this.credentials = credentials;
    this.syncStatus = null;
    this.connection = null;
    this.isConnecting = false;
    this.isPolling = false;
    this.lastChecked = 0;
    this.pollingInterval = POLLING_INTERVAL_BASE_MS + Math.floor(Math.random() * 5000);
    this.logDetails = { mailboxId: this.credentials.id, email: this.credentials.email };
  }

  async initialize() {
    const { data: status, error } = await supabase
      .from('mailbox_sync_status').select('*').eq('mailbox_id', this.credentials.id).single();

    if (error && error.code !== 'PGRST116') {
      log('ERROR', 'Erro ao buscar estado de sincronização.', { ...this.logDetails, error });
      return false;
    }
    if (status) {
      this.syncStatus = status;
    } else {
      const { data: newStatus, error: insertError } = await supabase
        .from('mailbox_sync_status')
        .insert({ email: this.credentials.email, mailbox_id: this.credentials.id, last_processed_uid: 0 })
        .select().single();
      if (insertError) {
        log('ERROR', 'Erro ao criar estado de sincronização inicial.', { ...this.logDetails, error: insertError });
        return false;
      }
      this.syncStatus = newStatus;
    }
    return true;
  }

  connect() {
    if (this.isConnecting || (this.connection && this.connection.state !== 'disconnected')) return;

    this.isConnecting = true;
    log('INFO', 'Conectando...', this.logDetails);

    try {
      this.connection = new Imap({
        user: this.credentials.email,
        password: this.credentials.password,
        host: this.credentials.imap_host,
        port: this.credentials.imap_port || 993,
        tls: this.credentials.imap_secure,
      });
      this.connection.once('ready', () => this.handleReady());
      this.connection.once('error', (err) => this.handleError(err));
      this.connection.once('end', () => this.handleEnd());
      this.connection.connect();
    } catch (error) {
      log('ERROR', 'Erro na configuração da conexão.', { ...this.logDetails, error: error.message });
      this.isConnecting = false;
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
  }

  handleReady() {
    log('INFO', 'Conexão estabelecida.', this.logDetails);
    this.isConnecting = false;
    this.connection.openBox('INBOX', false, async (err, box) => {
      if (err) {
        log('ERROR', 'Erro ao abrir INBOX.', { ...this.logDetails, err });
        return;
      }
      if (!this.syncStatus.initial_sync_completed_at) {
        log('INFO', 'Primeira conexão, configurando estado inicial.', this.logDetails);
        const firstSyncTime = new Date().toISOString();
        const latestUID = box.uidnext;
        await this.updateSyncStatus({
          initial_sync_completed_at: firstSyncTime,
          last_processed_uid: latestUID - 1,
        });
        log('INFO', `Configuração inicial concluída. UID de partida: ${latestUID - 1}.`, this.logDetails);
      }
    });
  }

  handleError(err) {
    log('ERROR', 'Erro na conexão IMAP.', { ...this.logDetails, code: err.code, message: err.message });
    if (err.code === 'AUTHENTICATIONFAILED') {
      log('ERROR', 'FALHA DE AUTENTICAÇÃO. Removendo mailbox da gestão ativa.', this.logDetails);
      managedMailboxes.delete(this.credentials.id);
    }
    this.isConnecting = false;
  }

  handleEnd() {
    log('WARN', 'Conexão IMAP encerrada. Agendando reconexão...', this.logDetails);
    this.isConnecting = false;
    this.connection = null;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  disconnect() {
    if (this.connection) {
      log('INFO', 'Desconectando intencionalmente.', this.logDetails);
      this.connection.end();
    }
  }

  async pollForNewEmails() {
    if (this.isPolling || !this.connection || this.connection.state !== 'authenticated' || !this.syncStatus.initial_sync_completed_at) {
      return;
    }

    this.isPolling = true;
    this.lastChecked = Date.now();
    await this.updateSyncStatus({ last_synced_at: new Date().toISOString() });

    const lastUID = this.syncStatus.last_processed_uid;

    console.log('lastUID:', lastUID);
    const searchCriteria = ['UID', `${lastUID + 1}:*`];

    return new Promise((resolve) => {
      this.connection.search(searchCriteria, (err, uids) => {
        if (err) {
          log('ERROR', 'Erro ao buscar e-mails.', { ...this.logDetails, err });
          this.isPolling = false;
          return resolve();
        }

        if (uids.length === 0) {
          this.isPolling = false;
          return resolve();
        }

        log('INFO', `Encontrados ${uids.length} novos e-mails.`, this.logDetails);
        const fetch = this.connection.fetch(uids, { bodies: '' });

        fetch.on('message', (msg) => {
          let messageUID;
          msg.on('attributes', (attrs) => { messageUID = attrs.uid; });
          msg.on('body', (stream) => {
            simpleParser(stream, async (parseErr, parsedEmail) => {
              if (parseErr) {
                log('ERROR', `Erro ao parsear e-mail UID ${messageUID}.`, { ...this.logDetails, parseErr });
                return;
              }
              try {
                const savedEmailData = await this.saveEmailToDb(parsedEmail, messageUID);
                await this.updateSyncStatus({ last_processed_uid: messageUID });
                if (savedEmailData) {
                  await this.sendToWebhook(parsedEmail);
                }
              } catch (saveError) {
                log('ERROR', `Falha ao salvar e-mail UID ${messageUID}.`, { ...this.logDetails, saveError });
              }
            });
          });
        });

        fetch.once('end', () => {
          log('INFO', 'Lote de sincronização concluído.', this.logDetails);
          this.isPolling = false;
          resolve();
        });
      });
    });
  }

  async saveEmailToDb(parsedEmail, uid) {
    let originalFrom = null;
    if (parsedEmail.headers.has('return-path')) {
      const rawReturnPath = parsedEmail.headers.get('return-path');
      if (rawReturnPath && rawReturnPath.value && rawReturnPath.value[0] && rawReturnPath.value[0].address) {
        originalFrom = rawReturnPath.value[0].address;
      }
    }

    const emailData = {
      mailbox_id: this.credentials.id,
      email: this.credentials.email,
      message_id: parsedEmail.messageId,
      uid: uid,
      sender: { address: parsedEmail.from?.value[0]?.address, name: parsedEmail.from?.value[0]?.name },
      recipients: parsedEmail.to?.value,
      subject: parsedEmail.subject,
      body_text: parsedEmail.text,
      body_html: parsedEmail.html || null,
      received_at: parsedEmail.date,
      has_attachments: parsedEmail.attachments.length > 0,
      original_from: originalFrom,
      raw_headers: parsedEmail.headers
    };

    const { error } = await supabase.from('emails').insert(emailData);

    if (error) {
      if (error.code === '23505') {
        log('WARN', `E-mail duplicado (Message-ID: ${parsedEmail.messageId}). Pulando.`, this.logDetails);
        return null;
      }
      throw error;
    }
    return emailData;
  }

  async sendToWebhook(parsedEmail) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    let originalFrom = null;
    if (parsedEmail.headers.has('return-path')) {
      const rawReturnPath = parsedEmail.headers.get('return-path');
      if (rawReturnPath && rawReturnPath.value && rawReturnPath.value[0] && rawReturnPath.value[0].address) {
        originalFrom = rawReturnPath.value[0].address;
      }
    }

    try {
      await axios.post(webhookUrl, {
        client_id: this.credentials.email,
        from: parsedEmail.from?.value[0]?.address,
        to: parsedEmail.to?.value[0]?.address,
        subject: parsedEmail.subject,
        message_id: parsedEmail.messageId,
        date: parsedEmail.date,
        original_from: originalFrom,
        text: parsedEmail.text,
        html: parsedEmail.html
      });
      log('INFO', `Webhook enviado: ${parsedEmail.messageId}`, this.logDetails);
    } catch (error) {
      log('ERROR', `Falha ao enviar webhook: ${parsedEmail.messageId}`, { ...this.logDetails, error: error.message });
    }
  }

  async updateSyncStatus(fieldsToUpdate) {
    const { error } = await supabase
      .from('mailbox_sync_status')
      .update({ ...fieldsToUpdate, last_synced_at: new Date().toISOString() })
      .eq('mailbox_id', this.credentials.id);

    if (error) {
      log('ERROR', 'Falha ao atualizar sync_status no banco.', { ...this.logDetails, error });
    } else {
      this.syncStatus = { ...this.syncStatus, ...fieldsToUpdate };
    }
  }
}

async function reconcileAndManageMailboxes() {
  log('INFO', 'Iniciando loop de reconciliação de mailboxes...');
  try {
    const { data: assignedMailboxes, error } = await supabase
      .from('mailboxes')
      .select('*')
      .eq('active', true)
      .eq('instance_id', INSTANCE_ID);

    if (error) {
      log('ERROR', 'Falha ao buscar mailboxes do banco.', { error });
      return;
    }

    const dbMailboxIds = new Set(assignedMailboxes.map(mb => mb.id));

    for (const mailboxCredentials of assignedMailboxes) {
      if (!managedMailboxes.has(mailboxCredentials.id)) {
        log('INFO', `Nova mailbox detectada: ${mailboxCredentials.email}.`, { mailboxId: mailboxCredentials.id });
        const manager = new MailboxManager(mailboxCredentials);
        managedMailboxes.set(mailboxCredentials.id, manager);
        const initialized = await manager.initialize();
        if (initialized) manager.connect();
      }
    }

    for (const mailboxId of managedMailboxes.keys()) {
      if (!dbMailboxIds.has(mailboxId)) {
        log('INFO', `Removendo mailbox não mais atribuída.`, { mailboxId });
        const manager = managedMailboxes.get(mailboxId);
        manager.disconnect();
        managedMailboxes.delete(mailboxId);
      }
    }
  } catch (e) {
    log('ERROR', 'Erro crítico no loop de reconciliação.', { error: e.message });
  }
}

function pollManagedMailboxes() {
  managedMailboxes.forEach(manager => {
    if (Date.now() - manager.lastChecked > manager.pollingInterval) {
      manager.pollForNewEmails();
    }
  });
}

async function main() {
  log('INFO', 'Iniciando Multi-Worker...');
  await reconcileAndManageMailboxes();

  setInterval(reconcileAndManageMailboxes, RECONCILE_INTERVAL_MS);
  setInterval(pollManagedMailboxes, 5000);

  process.on('SIGINT', () => {
    log('INFO', 'Recebido SIGINT. Desconectando todas as mailboxes...');
    managedMailboxes.forEach(manager => manager.disconnect());
    setTimeout(() => process.exit(0), 2000);
  });
}

main();