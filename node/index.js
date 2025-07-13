// index.js
const Fastify = require('fastify');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
});

// removidos logs de “ready” para não gerar overhead em produção
redis.on('error', e => {
    // opcional: registrar em nível de alerta
});

redis.defineCommand('getSummary', {
    numberOfKeys: 1,
    lua: fs.readFileSync(path.join(__dirname, 'redis', 'lua', 'summary.lua'), 'utf8')
});

// desabilitamos completamente o logger do Fastify e mantemos bodyLimit
const fastify = Fastify({ logger: false, bodyLimit: 1e6 });

fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
        if (body.length === 0) {
            done(null, {});
        } else {
            try {
                done(null, JSON.parse(body.toString()));
            } catch (err) {
                err.statusCode = 400;
                done(err);
            }
        }
    }
);

// Enfileira o pagamento
fastify.post('/payments', async (req, reply) => {
    const { correlationId, amount } = req.body;
    if (!correlationId || !amount) {
        return reply.code(400).send({ error: 'correlationId e amount são obrigatórios' });
    }

    await redis.lpush('payment_queue', JSON.stringify({ correlationId, amount }));
    reply.code(202).send({ status: 'enqueued' });
});

// Retorna resumo de pagamentos, opcionalmente filtrado por janela de tempo
fastify.get('/payments-summary', async (req, reply) => {
    const { from, to } = req.query;

    if (from || to) {
        // sempre string
        const fromTs = from ? Date.parse(from).toString() : '-inf';
        const toTs = to ? Date.parse(to).toString() : '+inf';

        // executa o script Lua
        const raw = await redis.getSummary('payments', fromTs, toTs);
        const [dCount, dSum, fCount, fSum] = raw.map(x => parseFloat(x));

        return reply.send({
            default: { totalRequests: dCount, totalAmount: dSum },
            fallback: { totalRequests: fCount, totalAmount: fSum }
        });
    }

    // sem filtro (cache incremental)
    const reqs = await redis.hgetall('summary:requests');
    const amts = await redis.hgetall('summary:amount');
    return reply.send({
        default: {
            totalRequests: parseInt(reqs.default || '0', 10),
            totalAmount: parseFloat(amts.default || '0')
        },
        fallback: {
            totalRequests: parseInt(reqs.fallback || '0', 10),
            totalAmount: parseFloat(amts.fallback || '0')
        }
    });
});


// Endpoint secreto para limpeza, usado pelo script de teste
fastify.post('/purge-payments', async (_, reply) => {
    await redis.del('payments', 'summary:requests', 'summary:amount', 'payment_queue');
    reply.send({ message: 'All payments purged.' });
});

// apenas log de erro
fastify.listen({ port: 8080, host: '0.0.0.0', backlog: 10000 })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
