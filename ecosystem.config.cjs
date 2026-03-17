/** PM2: pm2 start ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: "ai-creative",
      script: "apps/api/dist/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
    },
  ],
};
