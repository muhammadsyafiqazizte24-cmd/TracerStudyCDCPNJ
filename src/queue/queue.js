'use strict';
const IORedis = require('ioredis');
const { Queue } = require('bullmq');

/** BullMQ mewajibkan maxRetriesPerRequest: null untuk koneksi worker. */
const createRedis = (url) => new IORedis(url, { maxRetriesPerRequest: null });

function createQueue({ queueName, jobAttempts }, connection) {
  return new Queue(queueName, {
    connection,
    defaultJobOptions: {
      attempts: jobAttempts,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}

module.exports = { createRedis, createQueue };
