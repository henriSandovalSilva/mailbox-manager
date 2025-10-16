require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'api-service',
      script: './api.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        INSTANCE_ID: process.env.INSTANCE_ID || 1,
        PORT: process.env.PORT || 3000,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_KEY: process.env.SUPABASE_KEY
      }
    },
    {
      name: 'worker-1',
      script: './worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        INSTANCE_ID: process.env.INSTANCE_ID || 1,
        PORT: process.env.PORT || 3000,
        WEBHOOK_URL: process.env.WEBHOOK_URL,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_KEY: process.env.SUPABASE_KEY
      }
    }
  ]
};