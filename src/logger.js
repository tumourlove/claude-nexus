class Logger {
  static error(module, method, message, details) {
    console.error(`[${module}:${method}] ${message}`, details || '');
  }

  static warn(module, method, message) {
    console.warn(`[${module}:${method}] ${message}`);
  }

  static info(module, method, message) {
    console.log(`[${module}:${method}] ${message}`);
  }
}

module.exports = { Logger };
