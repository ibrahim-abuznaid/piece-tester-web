module.exports = {
  apps: [
    {
      name: 'piece-tester',
      script: 'npx',
      args: 'tsx server/src/index.ts',
      cwd: '/opt/piece-tester',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '0.0.0.0',
      },
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/opt/piece-tester/logs/err.log',
      out_file: '/opt/piece-tester/logs/out.log',
      merge_logs: true,
    },
  ],
};
