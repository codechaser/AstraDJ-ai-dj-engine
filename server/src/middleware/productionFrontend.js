import express from 'express';
import path from 'node:path';

const backendOwnedPath = /^\/(?:api|socket\.io|health)(?:\/|$)/i;
const spaRoute = /^(?!\/(?:api|socket\.io|health)(?:\/|$)).*/i;

export function mountProductionFrontend(app, distDirectory) {
  const staticFiles = express.static(distDirectory, { fallthrough: true, index: false });

  app.use((req, res, next) => {
    if (backendOwnedPath.test(req.path)) return next();
    return staticFiles(req, res, next);
  });

  app.get(spaRoute, (req, res, next) => {
    if (!req.get('accept')?.toLowerCase().includes('text/html')) return next();
    res.sendFile(path.join(distDirectory, 'index.html'), (error) => {
      if (error) next();
    });
  });
}
