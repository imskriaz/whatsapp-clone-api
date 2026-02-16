// src/utils/logger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure log directory exists
const logDir = process.env.LOG_PATH || path.join(__dirname, '../../data/logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

// Define colors
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white'
};

winston.addColors(colors);

// Define format
const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
        
        if (Object.keys(meta).length > 0 && meta.service !== 'whatsapp-clone') {
            log += ` ${JSON.stringify(meta)}`;
        }
        
        return log;
    })
);

// Define transports
const transports = [];

// Console transport
if (process.env.LOG_CONSOLE !== 'false') {
    transports.push(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize({ all: true }),
                format
            ),
            level: process.env.LOG_LEVEL || 'info'
        })
    );
}

// File transport
if (process.env.LOG_FILE !== 'false') {
    transports.push(
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: parseInt(process.env.LOG_FILE_MAX_SIZE) || 5242880,
            maxFiles: parseInt(process.env.LOG_FILE_MAX_FILES) || 5,
            format
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: parseInt(process.env.LOG_FILE_MAX_SIZE) || 5242880,
            maxFiles: parseInt(process.env.LOG_FILE_MAX_FILES) || 5,
            format
        })
    );
}

// Create logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels,
    format,
    transports,
    exitOnError: false,
    defaultMeta: { service: 'whatsapp-clone' }
});

// Stream for Morgan
logger.stream = {
    write: (message) => {
        logger.http(message.trim());
    }
};

/**
 * Log with context
 */
logger.withContext = (context) => {
    return {
        error: (message, meta = {}) => logger.error(message, { ...context, ...meta }),
        warn: (message, meta = {}) => logger.warn(message, { ...context, ...meta }),
        info: (message, meta = {}) => logger.info(message, { ...context, ...meta }),
        debug: (message, meta = {}) => logger.debug(message, { ...context, ...meta }),
        http: (message, meta = {}) => logger.http(message, { ...context, ...meta })
    };
};

module.exports = logger;