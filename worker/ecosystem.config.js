module.exports = {
    apps: [
        {
            name: 'worker',
            script: 'index.js',
            exec_mode: 'fork',
            instances: 1,
            node_args: [
                '--expose-gc',
                '--max-semi-space-size=64',
                '--max-old-space-size=256'
            ].join(' '),
            env: {
                REDIS_HOST: process.env.REDIS_HOST,
                REDIS_PORT: process.env.REDIS_PORT,
                PROCESSOR_DEFAULT_URL: process.env.PROCESSOR_DEFAULT_URL,
                PROCESSOR_FALLBACK_URL: process.env.PROCESSOR_FALLBACK_URL,
            }
        }
    ]
};
