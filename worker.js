const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const supabase = require('./supabase.js');

const RECONNECT_DELAY_BASE_MS = 5000;
const RECONNECT_DELAY_MAX_MS = 300000;
let currentReconnectDelay = RECONNECT_DELAY_BASE_MS;
let isReconnecting = false;

const mailboxId = process.env.MAILBOX_ID;

if (!mailboxId) {
    console.error(`[PID: ${process.pid}] ERRO CRÍTICO: MAILBOX_ID não fornecido. Encerrando.`);
    process.exit(1);
}

let imapConnection;
let mailboxCredentials;
let syncStatus;

function log(level, message, details) {
    const logObject = { timestamp: new Date().toISOString(), level, mailboxId, message, ...details };
    console.log(JSON.stringify(logObject));
}

async function initializeState() {
    log('INFO', 'Inicializando estado do worker...');

    const { data: credentials, error: credError } = await supabase
        .from('mailboxes').select('*').eq('id', mailboxId).single();

    if (credError || !credentials) {
        log('ERROR', 'Não foi possível buscar as credenciais.', { error: credError });
        return false;
    }
    mailboxCredentials = credentials;

    const { data: status, error: syncError } = await supabase
        .from('mailbox_sync_status').select('*').eq('mailbox_id', mailboxId).single();

    if (syncError && syncError.code !== 'PGRST116') {
        log('ERROR', 'Erro ao buscar estado de sincronização.', { error: syncError });
        return false;
    }

    if (status) {
        syncStatus = status;
    } else {
        const { data: newStatus, error: insertError } = await supabase
            .from('mailbox_sync_status')
            .insert({ mailbox_id: mailboxId, last_processed_uid: 0 })
            .select()
            .single();
        if (insertError) {
            log('ERROR', 'Erro ao criar estado de sincronização inicial.', { error: insertError });
            return false;
        }
        syncStatus = newStatus;
    }

    log('INFO', `Estado inicializado para ${mailboxCredentials.email}. Último UID: ${syncStatus.last_processed_uid}. Sync inicial completo: ${!!syncStatus.initial_sync_completed_at}`);
    return true;
}

async function updateLastProcessedUID(uid) {
    syncStatus.last_processed_uid = uid;
    const { error } = await supabase
        .from('mailbox_sync_status')
        .update({ last_processed_uid: uid, last_synced_at: new Date().toISOString() })
        .eq('mailbox_id', mailboxId);

    if (error) {
        log('ERROR', `Falha ao atualizar o último UID para ${uid} no banco.`, { error });
    }
}

function connect() {
    if (imapConnection && imapConnection.state !== 'disconnected') {
        log('WARN', 'Tentativa de conectar enquanto já existe uma conexão ativa ou em andamento.');
        return;
    }

    log('INFO', `Conectando ao servidor IMAP ${mailboxCredentials.imap_host}...`);
    imapConnection = new Imap({
        user: mailboxCredentials.imap_user,
        password: mailboxCredentials.imap_pass,
        host: mailboxCredentials.imap_host,
        port: mailboxCredentials.imap_port || 993,
        tls: mailboxCredentials.imap_tls !== false,
    });

    imapConnection.once('ready', handleReady);
    imapConnection.once('error', handleError);
    imapConnection.once('end', handleEnd);

    imapConnection.connect();
}

function handleReady() {
    log('INFO', 'Conexão IMAP estabelecida com sucesso.');
    isReconnecting = false;
    currentReconnectDelay = RECONNECT_DELAY_BASE_MS;

    imapConnection.openBox('INBOX', false, async (err, box) => {
        if (err) {
            log('ERROR', 'Erro ao abrir a caixa de entrada (INBOX).', { error: err });
            return;
        }
        log('INFO', 'Caixa de entrada aberta.', { totalMessages: box.messages.total });

        if (!syncStatus.initial_sync_completed_at) {
            log('INFO', 'Primeira conexão para esta mailbox. Realizando configuração inicial.');

            const firstSyncTime = new Date().toISOString();
            const latestUID = box.uidnext;

            const { error: updateError } = await supabase
                .from('mailbox_sync_status')
                .update({
                    initial_sync_completed_at: firstSyncTime,
                    last_processed_uid: latestUID - 1
                })
                .eq('mailbox_id', mailboxId);

            if (updateError) {
                log('ERROR', 'Falha ao salvar o estado da sincronização inicial.', { error: updateError });
                return;
            }

            syncStatus.initial_sync_completed_at = firstSyncTime;
            syncStatus.last_processed_uid = latestUID - 1;

            log('INFO', `Configuração inicial concluída. Sincronização começará a partir do UID ${syncStatus.last_processed_uid}.`);

        } else {
            syncMissingEmails();
        }

        imapConnection.on('mail', () => {
            log('INFO', 'Novo e-mail recebido! Sincronizando novamente...');
            syncMissingEmails();
        });
    });
}

function syncMissingEmails() {
    if (!syncStatus || !syncStatus.initial_sync_completed_at) {
        log('WARN', 'Tentativa de sincronizar antes da configuração inicial ser concluída.');
        return;
    }

    const lastUID = syncStatus.last_processed_uid;
    log('INFO', `Iniciando sincronização de e-mails a partir do UID > ${lastUID}`);

    const searchCriteria = ['UID', `${lastUID + 1}:*`];

    imapConnection.search([searchCriteria], (err, uids) => {
        if (err) {
            log('ERROR', 'Erro ao buscar por novos e-mails.', { error: err });
            return;
        }

        if (uids.length === 0) {
            log('INFO', 'Nenhum e-mail novo encontrado. Sincronização em dia.');
            return;
        }

        log('INFO', `Encontrados ${uids.length} novos e-mails para processar.`);

        const fetch = imapConnection.fetch(uids, { bodies: '' });
        fetch.on('message', (msg, seqno) => {
            let messageUID;
            msg.on('attributes', (attrs) => {
                messageUID = attrs.uid;
            });

            msg.on('body', (stream) => {
                simpleParser(stream, async (err, parsedEmail) => {
                    if (err) {
                        log('ERROR', `Erro ao parsear e-mail UID ${messageUID}.`, { error: err });
                        return;
                    }

                    try {
                        log('INFO', `Processando e-mail UID ${messageUID} | Assunto: ${parsedEmail.subject}`);

                        await saveEmailToDb(parsedEmail, messageUID);

                        await updateLastProcessedUID(messageUID);
                    } catch (saveError) {
                        log('ERROR', `Falha ao salvar e-mail UID ${messageUID} no banco.`, { error: saveError });
                    }
                });
            });
        });

        fetch.once('error', (fetchErr) => {
            log('ERROR', 'Erro durante o fetch de e-mails.', { error: fetchErr });
        });

        fetch.once('end', () => {
            log('INFO', 'Lote de sincronização de e-mails concluído.');
        });
    });
}

async function saveEmailToDb(parsedEmail, uid) {
    const emailData = {
        mailbox_id: mailboxId,
        message_id: parsedEmail.messageId,
        uid: uid,
        sender: { address: parsedEmail.from?.value[0]?.address, name: parsedEmail.from?.value[0]?.name },
        recipients: parsedEmail.to?.value,
        subject: parsedEmail.subject,
        body_text: parsedEmail.text,
        body_html: parsedEmail.html || null,
        received_at: parsedEmail.date,
        raw_headers: parsedEmail.headers,
        has_attachments: parsedEmail.attachments.length > 0
    };

    const { error } = await supabase.from('emails').insert(emailData);

    if (error) {
        if (error.code === '23505') {
            log('WARN', `E-mail com Message-ID ${parsedEmail.messageId} já existe no banco. Pulando.`);
            return;
        }
        throw error;
    }

    log('INFO', `E-mail UID ${uid} salvo com sucesso no banco de dados.`);
}


function handleError(err) {
    if (err.code === 'AUTHENTICATIONFAILED') {
        log('ERROR', 'FALHA NA AUTENTICAÇÃO! Verifique as credenciais. O worker não tentará reconectar.', { code: err.code });
        process.exit(1);
    }
    log('ERROR', 'Ocorreu um erro na conexão IMAP.', { code: err.code, message: err.message });
}

function handleEnd() {
    log('WARN', 'Conexão IMAP encerrada. Tentando reconectar...');
    reconnect();
}

function reconnect() {
    if (isReconnecting) return;
    isReconnecting = true;

    log('INFO', `Agendando reconexão em ${currentReconnectDelay / 1000} segundos.`);

    setTimeout(() => {
        isReconnecting = false;
        connect();
        currentReconnectDelay = Math.min(currentReconnectDelay * 2, RECONNECT_DELAY_MAX_MS);
    }, currentReconnectDelay);
}

async function main() {
    const isReady = await initializeState();
    if (isReady) {
        connect();
    } else {
        log('ERROR', 'Worker não pôde ser inicializado. Tentando novamente em 60 segundos...');
        setTimeout(main, 60000);
    }
}

main();

process.on('SIGINT', () => {
    log('INFO', 'Recebido sinal SIGINT. Encerrando worker de forma limpa...');
    if (imapConnection) {
        imapConnection.end();
    }
    process.exit(0);
});