'use strict';

const _ = require('lodash');
const path = require('path');
const Promise = require('bluebird');
const debug = require('debug')('knex-migrator:index');
const utils = require('./utils');
const errors = require('./errors');
const logging = require('../logging');
const database = require('./database');

class Migrations {
    constructor(init,
        migrationPath,
        dbConfig,
        runDatabaseUpgrades,
        lock,
        integrityCheck,
        unlock,
        _rollback,
        subfolder,
        createTransaction,
        afterEach) {
        this.init = init;
        this.migrationPath = migrationPath;
        this.dbConfig = database;
        this.runDatabaseUpgrades = runDatabaseUpgrades;
        this.lock = lock;
        this.integrityCheck = integrityCheck;
        this.unlock = unlock;
        this._rollback = _rollback;
        this.subfolder = subfolder;
        this.createTransaction = createTransaction;
        this.afterEach = afterEach;
    }
    /**
     * knex-migrator migrate
     * knex-migrator migrate --v v1.1
     * knex-migrator migrate --v v1.1 --force
     * knex-migrator migrate --v v1.1 --only 2
     * knex-migrator migrate --v v1.1 --skip 3
     * knex-migrator migrate --init
     *
     * **Not Allowed**
     * knex-migrator migrate --skip 3
     *
     * @TODO:
     *   - create more functions :P
     */
    migrate(options) {
        options = options || {};

        let self = this,
            onlyVersion = options.version,
            force = options.force,
            init = options.init,
            onlyFile = options.only,
            versionsToMigrate = [],
            hooks = {};

        if (onlyFile && !onlyVersion) {
            onlyFile = null;
        }

        if (onlyVersion) {
            debug('onlyVersion: ' + onlyVersion);
        }

        if (init) {
            return this.init()
                .then(function () {
                    return self.migrate(_.omit(options, 'init'));
                });
        }

        try {
            hooks = require(path.join(self.migrationPath, '/hooks/migrate'));
        } catch (err) {
            debug('Hook Error: ' + err.message);
            debug('No hooks found, no problem.');
        }

        this.connection = database.connect(this.dbConfig);

        return self.runDatabaseUpgrades()
            .then(function () {
                return self.lock();
            })
            .then(function () {
                return self.integrityCheck({
                    force: force
                });
            })
            .then(function (result) {
                _.each(result, function (value, version) {
                    if (onlyVersion && version !== onlyVersion) {
                        debug('Do not execute: ' + version);
                        return;
                    }
                });

                if (onlyVersion) {
                    let containsVersion = _.find(result, function (obj, key) {
                        return key === onlyVersion;
                    });

                    if (!containsVersion) {
                        logging.warn('Cannot find requested version: ' + onlyVersion);
                    }
                }

                _.each(result, function (value, version) {
                    if (value.expected !== value.actual) {
                        debug('Need to execute migrations for: ' + version);
                        versionsToMigrate.push(version);
                    }
                });
            })
            .then(function executeBeforeHook() {
                if (!versionsToMigrate.length) {
                    return;
                }

                if (hooks.before) {
                    debug('Before hook');
                    return hooks.before({
                        connection: self.connection
                    });
                }
            })
            .then(function executeMigrations() {
                if (!versionsToMigrate.length) {
                    return;
                }

                return Promise.each(versionsToMigrate, function (versionToMigrate) {
                    return self.migrateTo({
                        version: versionToMigrate,
                        only: onlyFile,
                        hooks: hooks
                    });
                });
            })
            .then(function executeAfterHook() {
                if (!versionsToMigrate.length) {
                    return;
                }

                if (hooks.after) {
                    debug('After hook');
                    return hooks.after({
                        connection: self.connection
                    });
                }
            })
            .then(function () {
                return self.unlock();
            })
            .catch(function (err) {
                // CASE: Do not rollback if migrations are locked
                if (err instanceof errors.MigrationsAreLockedError) {
                    throw err;
                }

                // CASE: Do not rollback migration scripts, if lock error
                if (err instanceof errors.LockError) {
                    throw err;
                }

                debug('Rolling back: ' + err.message);

                versionsToMigrate.reverse();
                return Promise.each(versionsToMigrate, function (version) {
                    return self._rollback({version: version});
                }).then(function () {
                    throw err;
                }).catch(function (innerErr) {
                    if (errors.utils.isIgnitionError(innerErr)) {
                        throw err;
                    }

                    throw new errors.RollbackError({
                        message: innerErr.message,
                        err: innerErr,
                        context: `OuterError: ${err.message}`
                    });
                }).finally(function () {
                    return self.unlock();
                });
            }).finally(function () {
                let ops = [];

                if (hooks.shutdown) {
                    ops.push(function shutdownHook() {
                        debug('Shutdown hook');
                        return hooks.shutdown();
                    });
                }

                ops.push(function destroyConnection() {
                    debug('Destroy connection');
                    return self.connection.destroy()
                        .then(function () {
                            debug('Destroyed connection');
                        });
                });

                return Promise.each(ops, function (op) {
                    return op.bind(self)();
                });
            });
    }

    /**
     * migrate to v1.1
     * migrate to init
     */
    migrateTo(options) {
        options = options || {};

        let self = this,
            version = options.version,
            hooks = options.hooks || {},
            only = options.only || null,
            skip = options.skip || null,
            subfolder = this.subfolder,
            skippedTasks = [],
            tasks = [];

        if (version !== 'init') {
            tasks = utils.readTasks(path.join(self.migrationPath, subfolder, version));
        } else {
            try {
                tasks = utils.readTasks(path.join(self.migrationPath, version));
            } catch (err) {
                if (err.code === 'MIGRATION_PATH') {
                    tasks = [];
                } else {
                    throw err;
                }
            }
        }

        if (only !== null) {
            debug('only: ' + only);
            tasks = [tasks[only - 1]];
        } else if (skip !== null) {
            debug('skip: ' + skip);
            tasks.splice(skip - 1, 1);
        }

        debug('Migrate: ' + version + ' with ' + tasks.length + ' tasks.');
        debug('Tasks: ' + JSON.stringify(tasks));

        return Promise.each(tasks, function executeTask(task) {
            return self.beforeEach({
                task: task.name,
                version: version
            }).then(function () {
                if (hooks.beforeEach) {
                    return hooks.beforeEach({
                        connection: self.connection
                    });
                }
            }).then(function () {
                debug('Running up: ' + task.name);

                if (task.config && task.config.transaction) {
                    return self.createTransaction(function (txn) {
                        return task.up({
                            transacting: txn
                        });
                    });
                }

                return task.up({
                    connection: self.connection
                });
            }).then(function () {
                if (hooks.afterEach) {
                    return hooks.afterEach({
                        connection: self.connection
                    });
                }
            }).then(function () {
                return self.afterEach({
                    task: task,
                    version: version
                });
            }).catch(function (err) {
                if (err instanceof errors.MigrationExistsError) {
                    debug('Skipping:' + task.name);
                    skippedTasks.push(task.name);
                    return Promise.resolve();
                }

                /**
                 * When your database encoding is set to utf8mb4 and you set a field length > 191 characters,
                 * MySQL will throw an error, BUT it won't roll back the changes, because ALTER/CREATE table commands are
                 * implicit commands.
                 *
                 * https://bugs.mysql.com/bug.php?id=28727
                 * https://github.com/TryGhost/knex-migrator/issues/51
                 */
                if (err.code === 'ER_TOO_LONG_KEY') {
                    let match = err.message.match(/`\w+`/g);
                    let table = match[0];
                    let field = match[2];

                    throw new errors.MigrationScriptError({
                        message: 'Field length of %field% in %table% is too long!'.replace('%field%', field).replace('%table%', table),
                        context: 'This usually happens if your database encoding is utf8mb4.\n' +
                            'All unique fields and indexes must be lower than 191 characters.\n' +
                            'Please correct your field length and reset your database with knex-migrator reset.\n',
                        help: 'Read more here: https://github.com/TryGhost/knex-migrator/issues/51\n',
                        err: err
                    });
                }

                throw new errors.MigrationScriptError({
                    message: err.message,
                    help: 'Error occurred while executing the following migration: ' + task.name,
                    err: err
                });
            });
        }).then(function () {
            return {
                skippedTasks: skippedTasks
            };
        });
    }

    beforeEach(options) {
        options = options || {};

        let task = options.task,
            version = options.version;

        return this.connection('migrations')
            .then(function (migrations) {
                if (!migrations.length) {
                    return;
                }

                if (_.find(migrations, {name: task, version: version})) {
                    throw new errors.MigrationExistsError();
                }
            });
    }
}

module.exports = Migrations;
