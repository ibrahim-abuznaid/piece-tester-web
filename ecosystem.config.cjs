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
      // Wait 3s before each restart — gives the OS time to release port 4000
      restart_delay: 3000,
      // Disable exponential backoff (100ms default causes EADDRINUSE crash loop)
      exp_backoff_restart_delay: 0,
      // Give the process 8s to exit cleanly on SIGINT before SIGKILL
      kill_timeout: 8000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/opt/piece-tester/logs/err.log',
      out_file: '/opt/piece-tester/logs/out.log',
      merge_logs: true,
    },
  ],
};
