/*
  Worker Node.js otimizado conforme Round 5 + métrica adaptativa de CHUNK_SIZE:
  - bulkhead concurrency (CHUNK_SIZE padrão)
  - se default minResponseTime < 500ms → CHUNK_SIZE default triplicado
  - failover adaptativo Default ⇄ Fallback
  - health-check com latencyThreshold
  - axios com timeout
  - logs de CPU e memória desativados (comentados) mas podem ser reativados
*/

const Redis = require('ioredis');
const axios = require('axios');

// configurações via ENV
const CHUNK_SIZE = parseInt(process.env.WORKER_CONCURRENCY, 10) || 80;
const QUEUE_THRESHOLD = parseInt(process.env.QUEUE_THRESHOLD, 10) || 1000;
const LATENCY_THRESHOLD = parseInt(process.env.LATENCY_THRESHOLD_MS, 10) || 5000;

// Redis
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
});

// URLs dos processadores
const DEFAULT_URL = process.env.PROCESSOR_DEFAULT_URL;
const FALLBACK_URL = process.env.PROCESSOR_FALLBACK_URL;
if (!DEFAULT_URL || !FALLBACK_URL) {
    throw new Error('DEFAULT_URL e FALLBACK_URL devem estar definidas');
}

// health-cache
let healthCache = {
    default: { ok: false, lastCheck: 0, minResponseTime: Infinity },
    fallback: { ok: false, lastCheck: 0, minResponseTime: Infinity },
};

// axios com timeout
const http = axios.create({ timeout: 3000 });

// utilitário de sleep
const sleep = ms => new Promise(r => setTimeout(r, ms));

// (opcional) métricas de CPU
let lastCpuUsage = process.cpuUsage();
function logMetrics() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    console.log(
        `[Metrics] RSS ${(mem.rss / 1024 / 1024).toFixed(1)}MB  ` +
        `Heap ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB  ` +
        `CPU Δ user ${(cpu.user / 1000).toFixed(1)}ms sys ${(cpu.system / 1000).toFixed(1)}ms`
    );
}

async function checkServiceHealth(url, key) {
    const now = Date.now();
    if (now - healthCache[key].lastCheck < 5000) {
        return healthCache[key];
    }
    try {
        const { data } = await http.get(`${url}/payments/service-health`);
        healthCache[key] = {
            ok: !data.failing,
            lastCheck: now,
            minResponseTime: data.minResponseTime
        };
    } catch {
        healthCache[key] = {
            ok: false,
            lastCheck: now,
            minResponseTime: Infinity
        };
    }
    return healthCache[key];
}

async function processPayment(item, useDefault, useFallback, nowIso) {
    const target = useDefault ? DEFAULT_URL : (useFallback ? FALLBACK_URL : null);
    const name = useDefault ? 'default' : 'fallback';
    if (!target) return;

    try {
        const resp = await http.post(`${target}/payments`, {
            correlationId: item.correlationId,
            amount: item.amount,
            requestedAt: nowIso
        });
        if (resp.status !== 200) throw new Error('status != 200');

        const score = Date.now();
        const member = JSON.stringify({
            correlationId: item.correlationId,
            processor: name,
            amount: item.amount
        });

        await redis.zadd('payments', score, member);
        await redis.hincrby('summary:requests', name, 1);
        await redis.hincrbyfloat('summary:amount', name, item.amount);
    } catch {
        await redis.rpush('payment_queue', JSON.stringify(item));
        if (useDefault) healthCache.default.ok = false;
    }
}

(async function runWorker() {
    console.log('Worker rodando com bulkhead e adaptativo de CHUNK_SIZE...');
    while (true) {
        try {
            // 1) health-check
            const [dHealth, fHealth] = await Promise.all([
                checkServiceHealth(DEFAULT_URL, 'default'),
                checkServiceHealth(FALLBACK_URL, 'fallback')
            ]);

            // 2) se ambos indisponíveis, espera
            if (!dHealth.ok && !fHealth.ok) {
                await sleep(100);
                continue;
            }

            // 3) verifica fila
            const queueLen = await redis.llen('payment_queue');
            if (queueLen === 0) {
                await sleep(50);
                continue;
            }

            // 4) lê batch
            const toFetch = Math.min(queueLen, 2000);
            const itemsRaw = await redis.lrange('payment_queue', -toFetch, -1);
            await redis.ltrim('payment_queue', 0, -toFetch - 1);
            const items = itemsRaw.map(x => JSON.parse(x));
            const nowIso = new Date().toISOString();

            // 5) decide distribuição de carga adaptativa
            let defaultItems = [], fallbackItems = [];
            if (!dHealth.ok && fHealth.ok) {
                // default down → tudo ao fallback
                fallbackItems = items;

            } else if (dHealth.ok && !fHealth.ok) {
                // fallback down → tudo ao default
                defaultItems = items;

            } else if (dHealth.minResponseTime > LATENCY_THRESHOLD || queueLen > QUEUE_THRESHOLD) {
                // cenário de estresse: split 50/50
                const half = Math.ceil(items.length / 2);
                defaultItems = items.slice(0, half);
                fallbackItems = items.slice(half);

            } else {
                // default saudável e rápido → tudo ao default
                defaultItems = items;
            }

            // 6) ajusta CHUNK_SIZE para default se minResponseTime < 500ms
            const chunkDefault = dHealth.minResponseTime <= 1000
                ? CHUNK_SIZE * 3
                : CHUNK_SIZE;
            const chunkFallback = CHUNK_SIZE;

            // 7) função de processamento em chunks
            const runChunks = async (list, useDef, useFb, chunkSize) => {
                for (let i = 0; i < list.length; i += chunkSize) {
                    const chunk = list.slice(i, i + chunkSize);
                    await Promise.all(chunk.map(item =>
                        processPayment(item, useDef, useFb, nowIso)
                    ));
                }
            };

            // 8) processa default e fallback em paralelo com chunkSizes adaptados
            await Promise.all([
                runChunks(defaultItems, true, false, chunkDefault),
                runChunks(fallbackItems, false, true, chunkFallback)
            ]);

            // 9) coleta de lixo manual
            if (global.gc) global.gc();

            // 10) (opcional) log de métricas
            // logMetrics();

        } catch (err) {
            console.error('Erro inesperado no worker:', err);
            await sleep(100);
        }
    }
})();
