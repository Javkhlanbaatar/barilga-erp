/**
 * PM2 process file for Barilga ERP.
 * API runs in cluster mode with one worker per CPU, 1GB memory ceiling, and auto-restart.
 */
module.exports = {
  apps: [
    {
      name: 'barilga-api',
      cwd: './apps/api',
      script: 'dist/main.js',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      exp_backoff_restart_delay: 200,
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        API_PORT: 4000,
      },
      error_file: '../logs/pm2-api-error.log',
      out_file: '../logs/pm2-api-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'barilga-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '../logs/pm2-web-error.log',
      out_file: '../logs/pm2-web-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
