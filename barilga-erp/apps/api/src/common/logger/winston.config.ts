import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import * as path from 'path';

const logsDir = path.resolve(process.cwd(), '../logs');

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/** Error logs: 14-day retention. */
const errorRotate = new winston.transports.DailyRotateFile({
  dirname: logsDir,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  zippedArchive: true,
  maxFiles: '14d',
  format: jsonFormat,
});

/** Business / info logs: 30-day retention. */
const infoRotate = new winston.transports.DailyRotateFile({
  dirname: logsDir,
  filename: 'business-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'info',
  zippedArchive: true,
  maxFiles: '30d',
  format: jsonFormat,
});

export const winstonConfig = {
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        nestWinstonModuleUtilities.format.nestLike('BarilgaERP', {
          colors: true,
          prettyPrint: true,
        }),
      ),
    }),
    errorRotate,
    infoRotate,
  ],
};
