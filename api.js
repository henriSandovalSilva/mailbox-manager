require('dotenv').config();
const express = require('express');
const pm2 = require('pm2');
const nodemailer = require('nodemailer');
const supabase = require('./supabase.js');
const Imap = require('node-imap');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function startPm2Worker(mailbox) {
  return new Promise((resolve, reject) => {
    const processName = `worker-mailbox-${mailbox.id}`;
    console.log(`Iniciando worker PM2: ${processName}`);

    const config = {
      script: './worker.js',
      name: processName,
      env: {
        MAILBOX_ID: mailbox.id,
      },
      autorestart: true,
      max_restarts: 5,
    };

    pm2.start(config, (err, proc) => {
      if (err) {
        console.error(`Erro ao iniciar o worker ${processName}:`, err);
        return reject(err);
      }
      console.log(`Worker ${processName} iniciado com sucesso.`);
      resolve(proc);
    });
  });
}

function stopPm2Worker(mailboxId) {
  return new Promise((resolve, reject) => {
    const processName = `worker-mailbox-${mailboxId}`;
    console.log(`Parando worker PM2: ${processName}`);

    pm2.delete(processName, (err) => {
      if (err) {
        if (err.message.includes('not found')) {
          console.warn(`Worker ${processName} não encontrado no PM2, pode já ter sido parado.`);
          return resolve();
        }
        console.error(`Erro ao parar o worker ${processName}:`, err);
        return reject(err);
      }
      console.log(`Worker ${processName} parado e removido com sucesso.`);
      resolve();
    });
  });
}

function validateImapCredentials(config) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.imap_user,
      password: config.imap_pass,
      host: config.imap_host,
      port: config.imap_port,
      tls: config.imap_tls,
    });

    const onError = (err) => {
      imap.removeListener('ready', onReady);
      reject(new Error(`Falha na validação IMAP: ${err.message}`));
    };

    const onReady = () => {
      imap.removeListener('error', onError);
      imap.end();
      resolve(true);
    };

    imap.once('ready', onReady);
    imap.once('error', onError);

    imap.connect();
  });
}

function validateSmtpCredentials(config) {
  return new Promise((resolve, reject) => {
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_secure,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass,
      },
    });

    transporter.verify((error, success) => {
      if (error) {
        reject(new Error(`Falha na validação SMTP: ${error.message}`));
      } else {
        resolve(true);
      }
    });
  });
}

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

app.get('/health/ready', async (req, res) => {
  try {
    const { error } = await supabase.from('mailboxes').select('id').limit(1);
    if (error) throw error;
    res.status(200).json({ status: 'ready', dependencies: { database: 'ok' } });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', dependencies: { database: 'error', details: error.message } });
  }
});

app.get('/api/mailboxes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mailboxes')
      .select('id, email, is_active, imap_host, smtp_host, created_at');

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar mailboxes', details: error.message });
  }
});

app.post('/api/mailboxes', async (req, res) => {
  try {
    const { email, imap_host, imap_port, imap_user, imap_pass, imap_tls, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure } = req.body;

    if (!email || !imap_host || !imap_port || !imap_user || !imap_pass || (imap_tls !== true && imap_tls !== false) || !smtp_host || !smtp_port || !smtp_user || !smtp_pass || (smtp_secure !== true && smtp_secure !== false)) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    console.log(`[VALIDAÇÃO] Testando credenciais IMAP para ${email}...`);
    await validateImapCredentials(req.body);
    console.log(`[VALIDAÇÃO] Credenciais IMAP para ${email} são válidas.`);

    console.log(`[VALIDAÇÃO] Testando credenciais SMTP para ${email}...`);
    await validateSmtpCredentials(req.body);
    console.log(`[VALIDAÇÃO] Credenciais SMTP para ${email} são válidas.`);

    console.log(`[INFO] Credenciais validadas. Inserindo mailbox ${email} no banco de dados...`);
    const { data, error } = await supabase
      .from('mailboxes')
      .insert([req.body])
      .select('id, email, created_at')
      .single();

    if (error) throw error;

    console.log(`[INFO] Mailbox ${email} inserida com sucesso. Iniciando worker...`);
    await startPm2Worker(data);

    res.status(201).json({ message: 'Mailbox adicionada e validada com sucesso!', data });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.', details: error.message });
    }

    if (error.message.includes('Falha na validação')) {
      console.error(`[VALIDAÇÃO] Erro: ${error.message}`);
      return res.status(400).json({ error: 'Credenciais inválidas.', details: error.message });
    }

    console.error(`[ERRO GERAL] Falha ao adicionar mailbox: ${error.message}`);
    res.status(500).json({ error: 'Erro interno ao adicionar mailbox', details: error.message });
  }
});

app.delete('/api/mailboxes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await stopPm2Worker(id);

    const { error } = await supabase.from('mailboxes').delete().eq('id', id);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: `Erro ao deletar mailbox ${id}`, details: error.message });
  }
});

app.get('/api/mailboxes/:mailboxId/emails', async (req, res) => {
  const { mailboxId } = req.params;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;

  try {
    const { data, error, count } = await supabase
      .from('emails')
      .select('*', { count: 'exact' })
      .eq('mailbox_id', mailboxId)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      data,
      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        limit: limit
      }
    });

  } catch (error) {
    res.status(500).json({ error: `Erro ao buscar e-mails para a mailbox ${mailboxId}`, details: error.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { from, to, subject, text, html, requestReadReceipt } = req.body;

  if (!from || !to || !subject || (!text && !html)) {
    return res.status(400).json({ error: 'Os campos "from", "to", "subject" e ("text" ou "html") são obrigatórios.' });
  }

  try {
    const { data: mailbox, error: dbError } = await supabase
      .from('mailboxes')
      .select('smtp_host, smtp_port, smtp_user, smtp_pass')
      .eq('email', from)
      .single();

    if (dbError || !mailbox) {
      return res.status(404).json({ error: `Mailbox de origem "${from}" não encontrada ou não configurada para envio.` });
    }

    const transporter = nodemailer.createTransport({
      host: mailbox.smtp_host,
      port: mailbox.smtp_port || 465,
      secure: (mailbox.smtp_port || 465) === 465,
      auth: {
        user: mailbox.smtp_user,
        pass: mailbox.smtp_pass,
      },
    });

    const mailOptions = {
      from: from,
      to: to,
      subject: subject,
      text: text,
      html: html,
    };

    if (requestReadReceipt === true) {
      mailOptions.headers = {
        'Disposition-Notification-To': from
      };
    }

    const info = await transporter.sendMail(mailOptions);

    console.log(`E-mail enviado: ${info.messageId}`);
    res.status(202).json({ success: true, message: 'E-mail enviado para a fila de processamento.', messageId: info.messageId });

  } catch (error) {
    console.error('Erro ao enviar e-mail:', error);
    res.status(500).json({ success: false, error: 'Falha ao enviar o e-mail.', details: error.message });
  }
});

async function syncWorkersOnStartup() {
  console.log('Sincronizando workers na inicialização...');
  try {
    const { data: mailboxes, error } = await supabase
      .from('mailboxes')
      .select('*')
      .eq('is_active', true);

    if (error) throw error;

    pm2.list((err, list) => {
      if (err) {
        console.error('Erro ao listar processos PM2:', err);
        return;
      }

      const runningWorkers = new Set(list.map(proc => proc.name));
      console.log('Workers atualmente em execução:', Array.from(runningWorkers));

      for (const mailbox of mailboxes) {
        const expectedName = `worker-mailbox-${mailbox.id}`;

        if (!runningWorkers.has(expectedName)) {
          console.warn(`Worker para a mailbox ${mailbox.id} (${mailbox.email}) não está rodando. Iniciando...`);
          startPm2Worker(mailbox).catch(err => {
            console.error(`Falha ao iniciar worker para mailbox ${mailbox.id} na sincronização.`, err);
          });
        } else {
          console.log(`Worker para a mailbox ${mailbox.id} já está em execução.`);
        }
      }
    });
  } catch (dbError) {
    console.error('Erro de banco de dados durante a sincronização inicial:', dbError);
  }
}

pm2.connect(true, (err) => {
  if (err) {
    console.error(err);
    process.exit(2);
  }

  app.listen(PORT, async () => {
    console.log(`Servidor de API rodando na porta ${PORT}`);
    await syncWorkersOnStartup();
  });
});

process.on('SIGINT', () => {
  pm2.disconnect();
  process.exit(0);
});