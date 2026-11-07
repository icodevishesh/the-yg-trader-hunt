// The Elefin API key is IP-allowlisted on the server's IPv4 address only. Node otherwise
// prefers IPv6 on this host and Elefin answers 403. src/elefin-client.js forces IPv4 too;
// NODE_OPTIONS is the second guard (npm passes it on to node).
const IPV4_ONLY = "--dns-result-order=ipv4first --no-network-family-autoselection";

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
        PORT: 3008,
        NODE_OPTIONS: IPV4_ONLY
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
        PORT: 3007,
        NODE_OPTIONS: IPV4_ONLY
      }
    }
  ]
};
