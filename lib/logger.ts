import Pino from 'pino';

const logger = Pino();
logger.level = 'trace';
export = logger;
