const logger = require('./utils/logger');
const config = require('./config');
const BugTracker = require('./bugtracker');
const bugtracker = new BugTracker('server');
const express = require('express');
const gitApi = require('./git-api');
const sysinfo = require('./sysinfo');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const semver = require('semver');
const path = require('path');
const fs = require('fs').promises;
const signals = require('signals');
const os = require('os');
const cache = require('./utils/cache');
const ffungitPlugin = require('./ffungit-plugin');
const serveStatic = require('serve-static');

process.on('uncaughtException', (err) => {
  logger.error(err.stack ? err.stack.toString() : err.toString());
  bugtracker.notify(err, 'ffungit-launcher');
  process.exit();
});

const users = config.users;
config.users = null; // So that we don't send the users to the client

if (config.authentication) {
  passport.serializeUser((username, done) => {
    done(null, username);
  });

  passport.deserializeUser((username, done) => {
    done(null, users[username] !== undefined ? username : null);
  });

  passport.use(
    new LocalStrategy((username, password, done) => {
      if (users[username] !== undefined && password === users[username]) done(null, username);
      else done(null, false, { message: 'No such username/password' });
    })
  );
}

const app = express();
const server = require('http').createServer(app);

gitApi.pathPrefix = '/api';

app.use((req, res, next) => {
  const rootPath = config.rootPath;
  if (req.url === rootPath) {
    // always have a trailing slash
    res.redirect(req.url + '/');
    return;
  }
  if (req.url.indexOf(rootPath) === 0) {
    req.url = req.url.substring(rootPath.length);
    next();
    return;
  }
  res.status(400).end();
});

if (config.logRESTRequests) {
  app.use((req, res, next) => {
    logger.info(req.method + ' ' + req.url);
    next();
  });
}

if (config.allowedIPs) {
  app.use((req, res, next) => {
    const ip =
      req.ip ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      req.connection.socket.remoteAddress;
    if (config.allowedIPs.indexOf(ip) >= 0) next();
    else {
      res
        .status(403)
        .send(
          '<h3>This host is not authorized to connect</h3>' +
            '<p>You are trying to connect to an ffungit instance from an unauthorized host.</p>'
        );
      logger.warn(`Host trying but not authorized to connect: ${ip}`);
    }
  });
}

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};
app.use(noCache);

app.use(require('body-parser').json());

if (config.autoShutdownTimeout) {
  let autoShutdownTimeout;
  const refreshAutoShutdownTimeout = () => {
    if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout);
    autoShutdownTimeout = setTimeout(() => {
      logger.info(
        `Shutting down ffungit due to inactivity. (autoShutdownTimeout is set to ${config.autoShutdownTimeout} ms`
      );
      process.exit(0);
    }, config.autoShutdownTimeout);
  };
  app.use((req, res, next) => {
    refreshAutoShutdownTimeout();
    next();
  });
  refreshAutoShutdownTimeout();
}

let ensureAuthenticated = (req, res, next) => {
  next();
};

if (config.authentication) {
  const cookieParser = require('cookie-parser');
  const session = require('express-session');
  const MemoryStore = require('memorystore')(session);
  app.use(cookieParser());
  app.use(
    session({
      store: new MemoryStore({
        checkPeriod: 86400000, // prune expired entries every 24h
      }),
      secret: 'ffungit',
      resave: true,
      saveUninitialized: true,
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  app.post('/api/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        res.status(401).json({ errorCode: 'authentication-failed', error: info.message });
        return;
      }
      req.logIn(user, (err) => {
        if (err) {
          return next(err);
        }
        res.json({ ok: true });
        return;
      });
    })(req, res, next);
  });

  app.get('/api/loggedin', (req, res) => {
    if (req.isAuthenticated()) res.json({ loggedIn: true });
    else res.json({ loggedIn: false });
  });

  app.get('/api/logout', (req, res) => {
    req.logout();
    res.json({ ok: true });
  });

  ensureAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
      return next();
    }
    res.status(401).json({
      errorCode: 'authentication-required',
      error: 'You have to authenticate to access this resource',
    });
  };
}

const indexHtmlCacheKey = cache.registerFunc(() => {
  return cache.resolveFunc(pluginsCacheKey).then((plugins) => {
    return fs.readFile(__dirname + '/../public/index.html', { encoding: 'utf8' }).then((data) => {
      return Promise.all(
        Object.values(plugins).map((plugin) => {
          return plugin.compile();
        })
      ).then((results) => {
        data = data.replace('<!-- ffungit-plugins-placeholder -->', results.join('\n\n'));
        data = data.replace(/__ROOT_PATH__/g, config.rootPath);

        return data;
      });
    });
  });
});

app.get('/', (req, res) => {
  if (config.dev) {
    cache.invalidateFunc(pluginsCacheKey);
    cache.invalidateFunc(indexHtmlCacheKey);
  }
  cache.resolveFunc(indexHtmlCacheKey).then((data) => {
    res.end(data);
  });
});

app.use(serveStatic(__dirname + '/../public'));

// Socket-IO
const socketIO = require('socket.io');
const socketsById = {};
let socketIdCounter = 0;
const io = socketIO(server, {
  path: config.rootPath + '/socket.io',
  logger: {
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    error: logger.error.bind(logger),
    warn: logger.warn.bind(logger),
  },
});
io.on('connection', (socket) => {
  const socketId = socketIdCounter++;
  socketsById[socketId] = socket;
  socket.socketId = socketId;
  socket.emit('connected', { socketId: socketId });
  socket.on('disconnect', () => delete socketsById[socketId]);
});

const apiEnvironment = {
  app: app,
  server: server,
  ensureAuthenticated: ensureAuthenticated,
  config: config,
  pathPrefix: gitApi.pathPrefix,
  socketIO: io,
  socketsById: socketsById,
};

gitApi.registerApi(apiEnvironment);

// Init plugins
const loadPlugins = (plugins, pluginBasePath) => {
  return fs.readdir(pluginBasePath).then((pluginDirs) => {
    return Promise.all(
      pluginDirs.map((pluginDir) => {
        const pluginPath = path.join(pluginBasePath, pluginDir);
        return fs
          .access(path.join(pluginPath, 'ffungit-plugin.json'))
          .then(() => {
            logger.info('Loading plugin: ' + pluginPath);
            const plugin = new ffungitPlugin({
              dir: pluginDir,
              httpBasePath: 'plugins/' + pluginDir,
              path: pluginPath,
            });
            if (plugin.manifest.disabled || plugin.config.disabled) {
              logger.info('Plugin disabled: ' + pluginDir);
              return;
            }
            plugin.init(apiEnvironment);
            plugins.push(plugin);
            logger.info('Plugin loaded: ' + pluginDir);
          })
          .catch(() => {
            // Skip direcories that don't contain an "ffungit-plugin.json".
          });
      })
    );
  });
};
const pluginsCacheKey = cache.registerFunc(() => {
  const plugins = [];
  return loadPlugins(plugins, path.join(__dirname, '..', 'components'))
    .then(() => {
      return fs
        .access(config.pluginDirectory)
        .then(() => loadPlugins(plugins, config.pluginDirectory))
        .catch(() => {
          /* ignore */
        });
    })
    .then(() => plugins);
});

app.get('/serverdata.js', (req, res) => {
  const text =
    `ffungit.config = ${JSON.stringify(config)};\n` +
    `ffungit.userHash = "${sysinfo.getUserHash()}";\n` +
    `ffungit.version = "${config.ffungitDevVersion}";\n` +
    `ffungit.platform = "${os.platform()}";\n` +
    `ffungit.pluginApiVersion = "${require('../package.json').ffungitPluginApiVersion}";\n`;
  res.set('Content-Type', 'application/javascript');
  res.send(text);
});

app.get('/api/latestversion', (req, res) => {
  sysinfo
    .getffungitLatestVersion()
    .then((latestVersion) => {
      if (!semver.valid(config.ffungitDevVersion)) {
        res.json({
          latestVersion: latestVersion,
          currentVersion: config.ffungitDevVersion,
          outdated: false,
        });
      } else {
        // We only want to show the "new version" banner if the major/minor version was bumped
        const latestSansPatch = semver(latestVersion);
        latestSansPatch.patch = 0;
        const currentSansPatch = semver(config.ffungitDevVersion);
        currentSansPatch.patch = 0;
        res.json({
          latestVersion: latestVersion,
          currentVersion: config.ffungitDevVersion,
          outdated: semver.gt(latestSansPatch, currentSansPatch),
        });
      }
    })
    .catch((err) => {
      res.json({
        latestVersion: config.ffungitDevVersion,
        currentVersion: config.ffungitDevVersion,
        outdated: false,
      });
    });
});

app.get('/api/ping', (req, res) => res.json({}));

app.get('/api/gitversion', (req, res) => {
  res.json(sysinfo.getGitVersionInfo());
});

const userConfigPath = path.join(config.homedir, '.ffungitrc');
const readUserConfig = () => {
  return fs
    .access(userConfigPath)
    .then(() => {
      return fs
        .readFile(userConfigPath, { encoding: 'utf8' })
        .then((content) => {
          return JSON.parse(content);
        })
        .catch((err) => {
          logger.error(`Stop at reading ~/.ffungitrc because ${err}`);
          process.exit(0);
        });
    })
    .catch(() => {
      return {};
    });
};
const writeUserConfig = (configContent) => {
  return fs.writeFile(userConfigPath, JSON.stringify(configContent, undefined, 2));
};

app.get('/api/userconfig', ensureAuthenticated, (req, res) => {
  readUserConfig()
    .then((userConfig) => {
      res.json(userConfig);
    })
    .catch((err) => {
      res.status(400).json(err);
    });
});
app.post('/api/userconfig', ensureAuthenticated, (req, res) => {
  writeUserConfig(req.body)
    .then(() => {
      res.json({});
    })
    .catch((err) => {
      res.status(400).json(err);
    });
});

app.get('/api/fs/exists', ensureAuthenticated, (req, res) => {
  fs.access(req.query['path'])
    .then(() => {
      res.json(true);
    })
    .catch(() => {
      res.json(false);
    });
});

app.get('/api/fs/listDirectories', ensureAuthenticated, (req, res) => {
  const dir = path.resolve(req.query.term.trim()).replace('/~', '');

  fs.readdir(dir, { withFileTypes: true })
    .then((files) => {
      const dirs = [];
      files.forEach((file) => {
        if (file.isDirectory()) {
          dirs.push(path.join(dir, file.name));
        }
      });
      return dirs;
    })
    .then((filteredFiles) => {
      filteredFiles.unshift(dir);
      res.json(filteredFiles);
    })
    .catch((err) => res.status(400).json(err));
});

// Error handling
app.use((err, req, res, next) => {
  bugtracker.notify(err, 'ffungit-node');
  logger.error(err.stack);
  res.status(500).send({ error: err.message, errorType: err.name, stack: err.stack });
});

exports.started = new signals.Signal();

server.listen({ port: config.port, host: config.ffungitBindIp }, () => {
  logger.info('Listening on port ' + config.port);
  console.log('## ffungit started ##'); // Consumed by bin/ffungit to figure out when the app is started
  exports.started.dispatch();
});
