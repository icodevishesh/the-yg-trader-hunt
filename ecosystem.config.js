
module.exports = {
  apps: [
    {
      name: "trader-hunt-test",
      cwd: "/home/ubuntu/the-yg-trader-hunt",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        APP_ENV: "testing",
        PORT: 3008
      }
    },
    {
      name: "trader-hunt-prod",
      cwd: "/home/ubuntu/the-yg-trader-hunt",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
        APP_ENV: "production",
        PORT: 3007
      }
    }
  ]
};
