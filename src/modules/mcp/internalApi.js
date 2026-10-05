import http from 'node:http';
import net from 'node:net';

/**
 * Llama a la API REST de FinanPro EN MEMORIA (sin red ni puertos): arma un request/response de Node
 * y los pasa por la app de Express. Así el MCP usa exactamente las mismas rutas, permisos,
 * validaciones, transacciones y reglas de negocio que la app web.
 */
export function callApi(app, { method = 'GET', path, query, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(
      Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]),
    ).toString();

    const req = new http.IncomingMessage(new net.Socket());
    req.method = method;
    req.url = `${path}${qs ? `?${qs}` : ''}`;
    req.headers = Object.fromEntries(Object.entries({ host: 'internal', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (body !== undefined) {
      req.body = body;
      req._body = true; // body-parser ya no intenta leer el stream
      req.headers['content-type'] = 'application/json';
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    const chunks = [];
    let done = false;
    // Se sobreescriben en la instancia: Express cambia el prototipo, pero las propiedades propias se mantienen
    res.write = function write(chunk, encoding, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (chunk) this.write(chunk, encoding);
      if (!done) {
        done = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: this.statusCode, data });
        this.emit('finish');
      }
      if (typeof cb === 'function') cb();
      return this;
    };

    try { app(req, res); } catch (err) { reject(err); }
  });
}
