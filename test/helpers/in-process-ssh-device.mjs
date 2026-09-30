#!/usr/bin/env node
/**
 * In-process SSH+SFTP test device: a real ssh2 server bound to 127.0.0.1:0 with
 * password auth, scripted exec responses, and a virtual-FS SFTP server (OPEN /
 * READ / WRITE / CLOSE / STAT / OPENDIR / READDIR / REALPATH subset). Lets the
 * SSH transport be regression-tested against the real wire protocol without an
 * external device.
 */
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

const FX_OK = 0;
const FX_EOF = 1;
const FX_NO_SUCH_FILE = 2;
const FXF_READ = 0x0001;
const FXF_WRITE = 0x0002;
const FXF_TRUNC = 0x0010;

function blankAttrs(mode, size = 0) {
  return { mode, uid: 0, gid: 0, size, atime: 0, mtime: Math.floor(Date.now() / 1000) };
}

export async function startInProcessSshDevice(options = {}) {
  const password = options.password ?? 'swordfish';
  const user = options.user ?? 'tester';
  /** path -> Buffer, shared between exec and sftp views. */
  const files = new Map(
    Object.entries(
      options.files ?? {
        '/etc/os-release': Buffer.from('ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\n'),
      }
    )
  );
  /** exact command -> { stdout?, stderr?, exit?, hang? } or function(info)->same */
  const commands = options.commands ?? {};

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // ssh2's key parser accepts RSA in PKCS#1 PEM; ed25519 would need OpenSSH format.
  const hostKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });

  const server = new ssh2.Server({ hostKeys: [hostKeyPem] });
  const liveConns = new Set();

  server.on('connection', (conn) => {
    liveConns.add(conn);
    conn.once('close', () => liveConns.delete(conn));
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === password) {
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, rejectExec, info) => {
          const spec =
            typeof commands[info.command] === 'function'
              ? commands[info.command](info)
              : commands[info.command];
          if (!spec) {
            rejectExec();
            return;
          }
          const stream = acceptExec();
          if (spec.stdout) stream.write(spec.stdout);
          if (spec.stderr) stream.stderr.write(spec.stderr);
          if (spec.hang) return; // never exits: client-side timeout exercises close()
          stream.exit(spec.exit ?? 0);
          stream.end();
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          // Key by handle bytes (hex): the client round-trips handles as fresh
          // Buffers, so Buffer identity must never be the Map key.
          const handles = new Map();
          let nextHandle = 1;

          const isDir = (p) =>
            p === '/' || [...files.keys()].some((f) => f.startsWith(p === '/' ? '/' : `${p}/`));

          const listDir = (p) => {
            const prefix = p === '/' ? '/' : `${p}/`;
            const names = new Set();
            for (const f of files.keys()) {
              if (!f.startsWith(prefix)) continue;
              const rest = f.slice(prefix.length);
              if (rest === '') continue;
              const first = rest.split('/')[0];
              if (rest.includes('/')) {
                names.add({ name: first, dir: true });
              } else {
                names.add({ name: first, dir: false });
              }
            }
            return [...names].map((n) => ({
              filename: n.name,
              longname: n.name,
              attrs: blankAttrs(
                n.dir ? 0o040755 : 0o100644,
                n.dir ? 0 : (files.get(prefix + n.name)?.length ?? 0)
              ),
            }));
          };

          sftp.on('REALPATH', (reqId, p) => {
            sftp.name(reqId, [{ filename: p, longname: p, attrs: blankAttrs(0o040755) }]);
          });
          sftp.on('STAT', (reqId, p) => {
            if (files.has(p)) {
              sftp.attrs(reqId, blankAttrs(0o100644, files.get(p).length));
            } else if (isDir(p)) {
              sftp.attrs(reqId, blankAttrs(0o040755));
            } else {
              sftp.status(reqId, FX_NO_SUCH_FILE, 'no such file');
            }
          });
          sftp.on('OPEN', (reqId, filename, flags) => {
            const id = String(nextHandle++);
            const h = Buffer.from(id);
            if (flags & FXF_WRITE) {
              const initial =
                flags & FXF_TRUNC || !files.has(filename) ? Buffer.alloc(0) : files.get(filename);
              handles.set(id, { path: filename, write: Buffer.from(initial) });
              sftp.handle(reqId, h);
              return;
            }
            if (flags & FXF_READ) {
              if (!files.has(filename)) {
                sftp.status(reqId, FX_NO_SUCH_FILE, 'no such file');
                return;
              }
              handles.set(id, { path: filename, read: files.get(filename) });
              sftp.handle(reqId, h);
              return;
            }
            sftp.status(reqId, FX_NO_SUCH_FILE, 'unsupported open flags');
          });
          sftp.on('FSTAT', (reqId, h) => {
            const entry = handles.get(h.toString());
            if (!entry) return sftp.status(reqId, FX_NO_SUCH_FILE, 'bad handle');
            const size = entry.read?.length ?? entry.write?.length ?? 0;
            sftp.attrs(reqId, blankAttrs(0o100644, size));
          });
          sftp.on('READ', (reqId, h, offset, len) => {
            const entry = handles.get(h.toString());
            if (!entry?.read) return sftp.status(reqId, FX_NO_SUCH_FILE, 'bad handle');
            if (offset >= entry.read.length) return sftp.status(reqId, FX_EOF);
            sftp.data(reqId, entry.read.subarray(offset, offset + len));
          });
          sftp.on('WRITE', (reqId, h, offset, data) => {
            const entry = handles.get(h.toString());
            if (!entry || entry.write === undefined) {
              return sftp.status(reqId, FX_NO_SUCH_FILE, 'bad handle');
            }
            const buf = entry.write;
            const grown =
              data.length + offset > buf.length
                ? Buffer.concat([buf, Buffer.alloc(data.length + offset - buf.length)])
                : buf;
            data.copy(grown, offset);
            entry.write = grown;
            sftp.status(reqId, FX_OK);
          });
          sftp.on('CLOSE', (reqId, h) => {
            const key = h.toString();
            const entry = handles.get(key);
            if (entry?.write) files.set(entry.path, entry.write);
            handles.delete(key);
            sftp.status(reqId, FX_OK);
          });
          sftp.on('OPENDIR', (reqId, p) => {
            if (!isDir(p)) return sftp.status(reqId, FX_NO_SUCH_FILE, 'no such dir');
            const id = String(nextHandle++);
            handles.set(id, { dirPath: p, readdirSent: false });
            sftp.handle(reqId, Buffer.from(id));
          });
          sftp.on('READDIR', (reqId, h) => {
            const entry = handles.get(h.toString());
            if (!entry?.dirPath) return sftp.status(reqId, FX_NO_SUCH_FILE, 'bad handle');
            if (entry.readdirSent) return sftp.status(reqId, FX_EOF);
            entry.readdirSent = true;
            sftp.name(reqId, listDir(entry.dirPath));
          });
        });
      });
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    port,
    files,
    close: () =>
      new Promise((resolve) => {
        for (const conn of liveConns) conn.end();
        server.close(() => resolve());
      }),
  };
}
