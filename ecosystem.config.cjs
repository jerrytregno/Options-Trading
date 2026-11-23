/** PM2 config for Lightsail (2 GB RAM). Keeps API + backtest worker heaps bounded. */
module.exports = {
  apps: [
    {
      name: "options-trading",
      cwd: __dirname,
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        BACKTEST_BUILD_HEAP_MB: "384",
      },
    },
  ],
};
