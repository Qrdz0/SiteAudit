class ScanError extends Error {
  constructor(message, status = 502, code = 'SCAN_FAILED') {
    super(message);
    this.name = 'ScanError';
    this.status = status;
    this.code = code;
  }
}

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500, code = 'INTERNAL', error = 'Something went wrong on our side. Please try again.';

  if (err instanceof ScanError) {
    ({ status, code } = err);
    error = err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400; code = 'BAD_JSON'; error = 'Request body is not valid JSON';
  } else if (err.type === 'entity.too.large') {
    status = 413; code = 'TOO_LARGE'; error = 'Request body too large';
  } else if (err.name === 'TimeoutError') {
    status = 504; code = 'TIMEOUT'; error = 'The site took too long to respond';
  } else if (/Protocol error|Target closed|Session closed|Navigation failed|net::ERR_/i.test(err.message)) {
    status = 502; code = 'BROWSER_ERROR'; error = 'Scan blocked by target site.';
  }

  if (status >= 500) console.error(`[${code}] ${req.method} ${req.originalUrl}`, err);
  res.status(status).type('application/json').json({ error, code });
}

module.exports = { ScanError, asyncRoute, notFound, errorHandler };
