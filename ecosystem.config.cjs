module.exports = {
  apps: [
    {
      name: 'sanction-api-telegram-bot',
      script: './dist/index.js',
      interpreter: 'node',
      node_args: '--env-file=.env',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
    },
  ],
};
