module.exports = {
  apps: [
    {
      name: "mcp-all-in-one",
      cwd: __dirname,
      script: "/bin/bash",
      args: [
        "-c",
        "set -a; source /etc/mcp-all-in-one/mcp-all-in-one.env; set +a; exec node build/index.js http",
      ],
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      out_file: "/tmp/mcp-out.log",
      error_file: "/tmp/mcp-err.log",
    },
  ],
};
