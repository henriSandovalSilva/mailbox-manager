require('dotenv').config();
const { ImapFlow } = require('imapflow');
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
    this.client = null;
    this.syncStatus = null;
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

  async connect() {
    if (this.isConnecting || (this.client && !this.client.closed)) return;

    this.isConnecting = true;
    log('INFO', 'Conectando via ImapFlow...', this.logDetails);

    try {
      this.client = new ImapFlow({
        host: this.credentials.imap_host,
        port: this.credentials.imap_port || 993,
        secure: this.credentials.imap_secure,
        auth: {
          user: this.credentials.email,
          pass: this.credentials.password
        },
        logger: false
      });

      await this.client.connect();
      await this.client.mailboxOpen('INBOX');
      this.isConnecting = false;

      log('INFO', 'Conexão IMAP estabelecida com sucesso.', this.logDetails);

      if (!this.syncStatus.initial_sync_completed_at) {
        const firstSyncTime = new Date().toISOString();
        const latestUID = this.client.mailbox.exists ? this.client.mailbox.uidNext - 1 : 0;
        await this.updateSyncStatus({
          initial_sync_completed_at: firstSyncTime,
          last_processed_uid: latestUID
        });
        log('INFO', `Configuração inicial concluída. UID de partida: ${latestUID}.`, this.logDetails);
      }
    } catch (error) {
      log('ERROR', 'Erro ao conectar com ImapFlow.', { ...this.logDetails, error: error.message });
      this.isConnecting = false;
      if (this.client) await this.client.logout().catch(() => {});
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
  }

  async disconnect() {
    if (this.client && !this.client.closed) {
      log('INFO', 'Desconectando ImapFlow.', this.logDetails);
      await this.client.logout().catch(() => {});
    }
  }

  async pollForNewEmails() {
    if (this.isPolling || !this.client || this.client.closed || !this.syncStatus.initial_sync_completed_at) return;

    this.isPolling = true;
    this.lastChecked = Date.now();
    await this.updateSyncStatus({ last_synced_at: new Date().toISOString() });

    const lastUID = this.syncStatus.last_processed_uid;
    const nextUID = lastUID + 1;

    log('INFO', `Verificando novos e-mails a partir do UID ${nextUID}.`, this.logDetails);

    try {
      const lock = await this.client.getMailboxLock('INBOX');
      let processedCount = 0;

      try {
        for await (const msg of this.client.fetch({ uid: `${nextUID}:*` }, { uid: true, source: true })) {
          if (msg.uid <= lastUID) continue;

          const parsedEmail = await simpleParser(msg.source);
          const savedEmailData = await this.saveEmailToDb(parsedEmail, msg.uid);

          if (savedEmailData) {
            await this.updateSyncStatus({ last_processed_uid: msg.uid });
            await this.sendToWebhook(parsedEmail);
            processedCount++;
          }
        }

        if (processedCount > 0) {
          log('INFO', `Lote de sincronização concluído. ${processedCount} e-mail(s) novo(s).`, this.logDetails);
        } else {
          log('INFO', 'Nenhum novo e-mail encontrado.', this.logDetails);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      log('ERROR', 'Erro ao buscar novos e-mails com ImapFlow.', { ...this.logDetails, error: err.message });
      if (err.code === 'AUTHENTICATIONFAILED') {
        managedMailboxes.delete(this.credentials.id);
      }
      await this.disconnect();
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    } finally {
      this.isPolling = false;
    }
  }

  async saveEmailToDb(parsedEmail, uid) {
    let originalFrom = null;
    const returnPath = parsedEmail.headers.get('return-path');
    if (returnPath?.value?.[0]?.address) {
      originalFrom = returnPath.value[0].address;
    }

    const emailData = {
      mailbox_id: this.credentials.id,
      email: this.credentials.email,
      message_id: parsedEmail.messageId,
      uid,
      sender: { address: parsedEmail.from?.value[0]?.address, name: parsedEmail.from?.value[0]?.name },
      recipients: parsedEmail.to?.value,
      subject: parsedEmail.subject,
      body_text: parsedEmail.text,
      body_html: parsedEmail.html || null,
      received_at: parsedEmail.date,
      has_attachments: parsedEmail.attachments?.length > 0,
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
    const returnPath = parsedEmail.headers.get('return-path');
    if (returnPath?.value?.[0]?.address) {
      originalFrom = returnPath.value[0].address;
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
      log('ERROR', 'Falha ao atualizar sync_status.', { ...this.logDetails, error });
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
      log('ERROR', 'Falha ao buscar mailboxes.', { error });
      return;
    }

    const dbMailboxIds = new Set(assignedMailboxes.map(mb => mb.id));

    for (const mailboxCredentials of assignedMailboxes) {
      if (!managedMailboxes.has(mailboxCredentials.id)) {
        log('INFO', `Nova mailbox detectada: ${mailboxCredentials.email}.`, { mailboxId: mailboxCredentials.id });
        const manager = new MailboxManager(mailboxCredentials);
        managedMailboxes.set(mailboxCredentials.id, manager);
        const initialized = await manager.initialize();
        if (initialized) await manager.connect();
      }
    }

    for (const mailboxId of managedMailboxes.keys()) {
      if (!dbMailboxIds.has(mailboxId)) {
        log('INFO', `Removendo mailbox não mais atribuída.`, { mailboxId });
        const manager = managedMailboxes.get(mailboxId);
        await manager.disconnect();
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
  log('INFO', 'Iniciando Multi-Worker (ImapFlow)...');
  await reconcileAndManageMailboxes();
  setInterval(reconcileAndManageMailboxes, RECONCILE_INTERVAL_MS);
  setInterval(pollManagedMailboxes, 5000);

  process.on('SIGINT', async () => {
    log('INFO', 'Encerrando todas as conexões...');
    for (const manager of managedMailboxes.values()) {
      await manager.disconnect();
    }
    setTimeout(() => process.exit(0), 2000);
  });
}

main();
