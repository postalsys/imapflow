import pino from 'pino';

const logger = pino();
logger.level = 'trace';

export default logger;
