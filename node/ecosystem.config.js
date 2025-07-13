module.exports = {
    apps: [
        {
            name: 'rinha-backend-server',
            script: 'index.js',
            exec_mode: 'cluster',
            instances: 1,
            env: {
                PROCESSOR_DEFAULT_URL: process.env.PROCESSOR_DEFAULT_URL,
                PROCESSOR_FALLBACK_URL: process.env.PROCESSOR_FALLBACK_URL,
                REDIS_HOST: process.env.REDIS_HOST,
                REDIS_PORT: process.env.REDIS_PORT
            }
        },
    ]
};
