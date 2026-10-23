// PM2 — wajib 1 instance mode fork. Dua proses dengan sesi yang sama akan saling
// menendang (connectionReplaced) dan memperbesar risiko ban.
module.exports = {
  apps: [{
    name: 'tracer-wa',
    script: 'src/index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 10000,
    kill_timeout: 15000,
    env: { NODE_ENV: 'production' },
  }],
};
