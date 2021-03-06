// # Ghost Server
// Handles the creation of an HTTP Server for Ghost
var debug = require('debug')('ghost:server'),
    Promise = require('bluebird'),
    fs = require('fs'),
    path = require('path'),
    _ = require('lodash'),
    errors = require('./errors'),
    events = require('./events'),
    logging = require('./logging'),
    config = require('./config'),
    utils = require('./utils'),
    i18n = require('./i18n'),
    moment = require('moment');

/**
 * ## GhostServer
 * @constructor
 * @param {Object} rootApp - parent express instance
 */
function GhostServer(rootApp) {
    this.rootApp = rootApp;
    this.httpServer = null;
    this.connections = {};
    this.connectionId = 0;

    // Expose config module for use externally.
    this.config = config;
}

/**
 * ## Public API methods
 *
 * ### Start
 * Starts the ghost server listening on the configured port.
 * Alternatively you can pass in your own express instance and let Ghost
 * start listening for you.
 * @param  {Object} externalApp - Optional express app instance.
 * @return {Promise} Resolves once Ghost has started
 */
GhostServer.prototype.start = function (externalApp) {
    debug('Starting...');
    var self = this,
        rootApp = externalApp ? externalApp : self.rootApp,
        socketConfig, socketValues = {
            path: path.join(config.get('paths').contentPath, config.get('env') + '.socket'),
            permissions: '660'
        };

    return new Promise(function (resolve, reject) {
        if (config.get('server').hasOwnProperty('socket')) {
            socketConfig = config.get('server').socket;

            if (_.isString(socketConfig)) {
                socketValues.path = socketConfig;
            } else if (_.isObject(socketConfig)) {
                socketValues.path = socketConfig.path || socketValues.path;
                socketValues.permissions = socketConfig.permissions || socketValues.permissions;
            }

            // Make sure the socket is gone before trying to create another
            try {
                fs.unlinkSync(socketValues.path);
            } catch (e) {
                // We can ignore this.
            }

            self.httpServer = rootApp.listen(socketValues.path);
            fs.chmod(socketValues.path, socketValues.permissions);
            config.set('server:socket', socketValues);
        } else {
            self.httpServer = rootApp.listen(
                config.get('server').port,
                config.get('server').host
            );
        }

        self.httpServer.on('error', function (error) {
            var ghostError;

            if (error.errno === 'EADDRINUSE') {
                ghostError = new errors.GhostError({
                    message: i18n.t('errors.httpServer.addressInUse.error'),
                    context: i18n.t('errors.httpServer.addressInUse.context', {port: config.get('server').port}),
                    help: i18n.t('errors.httpServer.addressInUse.help')
                });
            } else {
                ghostError = new errors.GhostError({
                    message: i18n.t('errors.httpServer.otherError.error', {errorNumber: error.errno}),
                    context: i18n.t('errors.httpServer.otherError.context'),
                    help: i18n.t('errors.httpServer.otherError.help')
                });
            }

            reject(ghostError);
        });
        self.httpServer.on('connection', self.connection.bind(self));
        self.httpServer.on('listening', function () {
            debug('...Started');
            events.emit('server:start');
            self.logStartMessages();
            resolve(self);
        });
    });
};

/**
 * ### Stop
 * Returns a promise that will be fulfilled when the server stops. If the server has not been started,
 * the promise will be fulfilled immediately
 * @returns {Promise} Resolves once Ghost has stopped
 */
GhostServer.prototype.stop = function () {
    var self = this;

    return new Promise(function (resolve) {
        if (self.httpServer === null) {
            resolve(self);
        } else {
            self.httpServer.close(function () {
                events.emit('server:stop');
                self.httpServer = null;
                self.logShutdownMessages();
                resolve(self);
            });

            self.closeConnections();
        }
    });
};

/**
 * ### Restart
 * Restarts the ghost application
 * @returns {Promise} Resolves once Ghost has restarted
 */
GhostServer.prototype.restart = function () {
    return this.stop().then(function (ghostServer) {
        return ghostServer.start();
    });
};

/**
 * ### Hammertime
 * To be called after `stop`
 */
GhostServer.prototype.hammertime = function () {
    logging.info(i18n.t('notices.httpServer.cantTouchThis'));

    return Promise.resolve(this);
};

/**
 * ## Private (internal) methods
 *
 * ### Connection
 * @param {Object} socket
 */
GhostServer.prototype.connection = function (socket) {
    var self = this;

    self.connectionId += 1;
    socket._ghostId = self.connectionId;

    socket.on('close', function () {
        delete self.connections[this._ghostId];
    });

    self.connections[socket._ghostId] = socket;
};

/**
 * ### Close Connections
 * Most browsers keep a persistent connection open to the server, which prevents the close callback of
 * httpServer from returning. We need to destroy all connections manually.
 */
GhostServer.prototype.closeConnections = function () {
    var self = this;

    Object.keys(self.connections).forEach(function (socketId) {
        var socket = self.connections[socketId];

        if (socket) {
            socket.destroy();
        }
    });
};

/**
 * ### Log Start Messages
 */
GhostServer.prototype.logStartMessages = function () {
    // Startup & Shutdown messages
    if (config.get('env') === 'production') {
        logging.info(i18n.t('notices.httpServer.ghostIsRunningIn', {env: config.get('env')}));
        logging.info(i18n.t('notices.httpServer.yourBlogIsAvailableOn', {url: utils.url.urlFor('home', true)}));
        logging.info(i18n.t('notices.httpServer.ctrlCToShutDown'));
    } else {
        logging.info(i18n.t('notices.httpServer.ghostIsRunningIn', {env: config.get('env')}));
        logging.info(i18n.t('notices.httpServer.listeningOn', {
            host: config.get('server').socket || config.get('server').host,
            port: config.get('server').port
        }));
        logging.info(i18n.t('notices.httpServer.urlConfiguredAs', {url: utils.url.urlFor('home', true)}));
        logging.info(i18n.t('notices.httpServer.ctrlCToShutDown'));
    }

    function shutdown() {
        logging.warn(i18n.t('notices.httpServer.ghostHasShutdown'));

        if (config.get('env') === 'production') {
            logging.warn(i18n.t('notices.httpServer.yourBlogIsNowOffline'));
        } else {
            logging.warn(
                i18n.t('notices.httpServer.ghostWasRunningFor'),
                moment.duration(process.uptime(), 'seconds').humanize()
            );
        }

        process.exit(0);
    }

    // ensure that Ghost exits correctly on Ctrl+C and SIGTERM
    process.removeAllListeners('SIGINT').on('SIGINT', shutdown).removeAllListeners('SIGTERM').on('SIGTERM', shutdown);
};

/**
 * ### Log Shutdown Messages
 */
GhostServer.prototype.logShutdownMessages = function () {
    logging.warn(i18n.t('notices.httpServer.ghostIsClosingConnections'));
};

module.exports = GhostServer;
