'use strict';

const _ = require('lodash');
const path = require('path');
const moment = require('moment');
const Promise = require('bluebird');
const debug = require('debug')('knex-migrator:index');
const database = require('./database');
const utils = require('./utils');
const errors = require('./errors');
const logging = require('../logging');
const Migrations = require('./migrations');

class KnexMigrator {
    constructor(options) {
        options = options || {};

        let config = this._loadConfig(options);

        if (!config.database) {
            throw new Error('MigratorConfig.js needs to export a database config.');
        }

        if (!config.migrationPath) {
            throw new Error('MigratorConfig.js needs to export the location of your migration files.');
        }

        if (!config.currentVersion) {
            throw new Error('MigratorConfig.js needs to export the a current version.');
        }

        this.currentVersion = config.currentVersion;
        this.migrationPath = config.migrationPath;
        this.subfolder = config.subfolder || 'versions';

        // @TODO: make test connection to database to ensure database credentials are OK
        this.dbConfig = config.database;

        // @TODO: create dialect hooks
        this.isMySQL = this.dbConfig.client === 'mysql';
        const migrations = new Migrations(this.init,
            this.migrationPath,
            this.dbConfig,
            this.runDatabaseUpgrades,
            this.lock,
            this.integrityCheck,
            this.unlock,
            this._rollback,
            this.subfolder,
            this.createTransaction,
            this.afterEach
        );
        this.migrate = migrations.migrate;
        this.migrateTo = migrations.migrateTo;
        this.beforeEach = migrations.beforeEach;
    }

    _loadConfig(options) {
        if (options.knexMigratorConfig) {
            return options.knexMigratorConfig;
        }

        let knexMigratorFilePath = options.knexMigratorFilePath || process.cwd();
        try {
            return require(path.join(path.resolve(knexMigratorFilePath), '/MigratorConfig.js'));
        } catch (err) {
            if (err.code === 'MODULE_NOT_FOUND') {
                throw new errors.KnexMigrateError({
                    message: 'Please provide a file named MigratorConfig.js in your project root.',
                    help: 'Read through the README.md to see which values are expected.'
                });
            }

            throw new errors.KnexMigrateError({err: err});
        }
    }

    /**
     * knex-migrator init
     */
    init(options) {
        options = options || {};

        let self = this,
            disableHooks = options.disableHooks,
            noScripts = options.noScripts,
            skipInitCompletion = options.skipInitCompletion,
            skippedTasks = [],
            hooks = {};

        try {
            if (!disableHooks) {
                hooks = require(path.join(self.migrationPath, '/hooks/init'));
            }
        } catch (err) {
            debug('Hook Error: ' + err.message);
            debug('No hooks found, no problem.');
        }

        this.connection = database.connect(this.dbConfig);

        return database.createDatabaseIfNotExist(self.dbConfig)
            .then(function () {
                if (noScripts) {
                    return;
                }

                // Create table outside of the transaction! (implicit)
                return self.createMigrationsTable().then(function () {
                    return self.runDatabaseUpgrades().then(function () {
                        return self.lock()
                            .then(function () {
                                if (hooks.before) {
                                    debug('Before hook');
                                    return hooks.before({
                                        connection: self.connection
                                    });
                                }
                            })
                            .then(function executeMigrate() {
                                return self.migrateTo({
                                    version: 'init',
                                    only: options.only,
                                    skip: options.skip
                                })
                            })
                            .then(function (response) {
                                skippedTasks = response.skippedTasks;

                                if (hooks.after) {
                                    debug('After hook');
                                    return hooks.after({
                                        connection: self.connection
                                    });
                                }
                            })
                            .then(function () {
                                // CASE: re-run init and e.g. one migration was added to the init folder.
                                if (skippedTasks.length || skipInitCompletion) {
                                    return Promise.resolve();
                                }

                                let versionsToMigrateTo;

                                // CASE: insert all migration files, otherwise you will run into problems
                                // e.g. you are on 1.2, you initialise the database, but there is 1.3 migration script
                                try {
                                    versionsToMigrateTo = utils.readFolders(path.join(self.migrationPath, self.subfolder)) || [];
                                } catch (err) {
                                    // CASE: versions folder does not exists
                                    if (err.code === 'READ_FOLDERS') {
                                        return Promise.resolve();
                                    }

                                    throw err;
                                }

                                return self.createTransaction(function (transacting) {
                                    return Promise.each(versionsToMigrateTo, function (versionToMigrateTo) {
                                        let versionPath = path.join(self.migrationPath, self.subfolder, versionToMigrateTo);
                                        let filesToMigrateTo = utils.readTasks(versionPath) || [];

                                        return Promise.each(filesToMigrateTo, function (fileToMigrateTo) {
                                            return transacting('migrations')
                                                .where('name', fileToMigrateTo.name)
                                                .then(function (migrationExists) {
                                                    if (migrationExists.length) {
                                                        return Promise.resolve();
                                                    }

                                                    return transacting('migrations')
                                                        .insert({
                                                            name: fileToMigrateTo.name,
                                                            version: versionToMigrateTo,
                                                            currentVersion: self.currentVersion
                                                        });
                                                });
                                        });
                                    });
                                });
                            })
                            .then(function () {
                                return self.unlock();
                            })
                            .catch(function (err) {
                                if (err instanceof errors.MigrationsAreLockedError) {
                                    throw err;
                                }

                                if (err instanceof errors.LockError) {
                                    throw err;
                                }

                                return self.unlock()
                                    .then(function () {
                                        throw err;
                                    });
                            });
                    });
                });
            })
            .then(function onInitSuccess() {
                debug('Init Success');
            })
            .catch(function onInitError(err) {
                // CASE: Do not rollback if migrations are locked
                if (err instanceof errors.MigrationsAreLockedError) {
                    throw err;
                }

                // CASE: Do not rollback migration scripts, if lock error
                if (err instanceof errors.LockError) {
                    throw err;
                }

                debug('Rolling back: ' + err.message);

                return self._rollback({
                    version: 'init',
                    skippedTasks: {
                        init: skippedTasks
                    }
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
                });
            })
            .finally(function () {
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

    _rollback(options) {
        let version = options.version;
        let skippedTasks = options.skippedTasks || [];
        let onlyTasks = options.onlyTasks || [];
        let tasks = [];
        let self = this;

        if (version !== 'init') {
            tasks = utils.readTasks(path.join(this.migrationPath, this.subfolder, version));
        } else {
            try {
                tasks = utils.readTasks(path.join(this.migrationPath, version));
            } catch (err) {
                if (err.code === 'MIGRATION_PATH') {
                    tasks = [];
                } else {
                    throw err;
                }
            }
        }

        tasks.reverse();

        return Promise.each(tasks, function (task) {
            if (skippedTasks[version] && skippedTasks[version].indexOf(task.name) !== -1) {
                return Promise.resolve();
            }

            if (onlyTasks.length && onlyTasks.indexOf(task.name) === -1) {
                return Promise.resolve();
            }

            if (!task.down) {
                debug('No down function provided', task.name);
                return self.connection('migrations')
                    .where({
                        name: task.name,
                        version: version,
                        currentVersion: self.currentVersion
                    })
                    .delete();
            }

            debug('Rollback', task.name);
            return task.down({
                connection: self.connection
            }).then(function () {
                return self.connection('migrations')
                    .where({
                        name: task.name,
                        version: version,
                        currentVersion: self.currentVersion
                    })
                    .delete();
            });
        });
    }

    /**
     * will delete the target database
     *
     * @TODO:
     * - think about deleting only the tables
     * - move to database utility (?)
     * - tidy up
     */
    reset(options) {
        options = options || {};

        let self = this;
        let force = options.force;

        this.connection = database.connect(this.dbConfig);

        // CASE: ignore lock
        if (force) {
            return database.drop({
                connection: self.connection,
                dbConfig: self.dbConfig
            }).catch(function onRestError(err) {
                // Database does not exist. MySql.
                if (err.errno === 1049) {
                    return Promise.resolve();
                }

                throw err;
            }).finally(function () {
                debug('Destroy connection');
                return self.connection.destroy()
                    .then(function () {
                        debug('Destroyed connection');
                    });
            });
        }

        return this.runDatabaseUpgrades()
            .then(function () {
                return self.lock();
            })
            .then(function () {
                return database.drop({
                    connection: self.connection,
                    dbConfig: self.dbConfig
                });
            })
            .catch(function onRestError(err) {
                if (err instanceof errors.MigrationsAreLockedError) {
                    throw err;
                }

                debug('Reset error: ' + err.message);

                // Database does not exist. MySql.
                if (err.errno === 1049) {
                    return Promise.resolve();
                }

                return self.unlock()
                    .then(function () {
                        throw err;
                    });
            })
            .finally(function () {
                debug('Destroy connection');
                return self.connection.destroy()
                    .then(function () {
                        debug('Destroyed connection');
                    });
            });
    }

    // @TODO: rollback migrations table if init fails?
    createMigrationsTable() {
        let self = this;

        return this.connection('migrations')
            .catch(function (err) {
                // CASE: table does not exist
                if (err.errno === 1 || err.errno === 1146) {
                    debug('Creating table: migrations');

                    return self.connection.schema.createTable('migrations', function (table) {
                        table.increments().primary();
                        table.string('name');
                        table.string('version');
                        table.string('currentVersion');
                    });
                }

                throw err;
            });
    }

    ensureLockTable() {
        let self = this;

        debug('Ensure Lock Table.');

        return this.connection.schema.hasTable('migrations_lock')
            .then(function (table) {
                if (table) {
                    return
                }

                return self.connection.schema.createTable('migrations_lock', function (table) {
                    table.string('lock_key', 191).nullable(false).unique();
                    table.boolean('locked').default(0);
                    table.dateTime('acquired_at').nullable();
                    table.dateTime('released_at').nullable();
                }).then(function () {
                    return self.connection('migrations_lock')
                        .insert({
                            lock_key: 'km01',
                            locked: 0
                        });
                }).catch(function (err) {
                    // CASE: sqlite db is locked (e.g. concurrent migrations are running)
                    if (err.errno === 5) {
                        throw new errors.MigrationsAreLockedError({
                            message: 'Migrations are running at the moment. Please wait that the lock get`s released.',
                            context: 'Either the release was never released because of a e.g. died process or a parallel process is migrating at the moment.',
                            help: 'If you know what you are doing, you can manually release the lock by running `UPDATE migrations_lock set locked=0 where lock_key=\'km01\';`.'
                        });
                    }

                    throw err;
                });
            });
    }

    ensureFieldLength() {
        debug('Ensure Field Length.');
        let self = this;

        return this.connection.schema.hasTable('migrations')
            .then(function (exists) {
                if (exists) {
                    return self.connection.schema.alterTable('migrations', function (table) {
                        table.string('name', 120).nullable(false).alter();
                        table.string('version', 70).nullable(false).alter();
                    }).catch(function () {
                        // ignore for now, it's not a urgent, required change
                        return Promise.resolve();
                    });
                }
            });
    }

    ensureUniqueIndex() {
        debug('Ensure Unique Index.');
        let self = this;

        return this.connection.schema.hasTable('migrations')
            .then(function (exists) {
                if (exists) {
                    return self.connection.schema.alterTable('migrations', function (table) {
                        table.unique(['name', 'version']);
                    }).catch(function () {
                        // ignore for now, it's not a urgent, required change
                        // e.g. index exists already (1061,1)
                        // e.g. can't index because of already existing duplicates
                        return Promise.resolve();
                    });
                }
            });
    }

    /**
     * If we want to extend the `migrations` or `migrations_lock` table.
     */
    runDatabaseUpgrades() {
        let self = this;

        return this.ensureLockTable()
            .then(function () {
                return self.ensureFieldLength();
            })
            .then(function () {
                return self.ensureUniqueIndex();
            });
    }

    /**
     * Locks in Sqlite won't work, because Sqlite doesn't offer read locks.
     * @TODO: Enable WAL journal? Exclusive Transactions?
     */
    lock() {
        let self = this;
        debug('Lock.');

        return self.createTransaction(function (transacting) {
            return transacting('migrations_lock')
                .where({
                    lock_key: 'km01'
                })
                .forUpdate()
                .then(function (data) {
                    if (!data || !data.length || data[0].locked) {
                        throw new errors.MigrationsAreLockedError({
                            message: 'Migrations are running at the moment. Please wait that the lock get`s released.',
                            context: 'Either the release was never released because of a e.g. died process or a parallel process is migrating at the moment.',
                            help: 'If your database looks okay, you can manually release the lock by running `UPDATE migrations_lock set locked=0 where lock_key=\'km01\';`.'
                        });
                    }

                    return (transacting || self.connection)('migrations_lock')
                        .where({
                            lock_key: 'km01'
                        })
                        .update({
                            locked: 1,
                            acquired_at: moment().format('YYYY-MM-DD HH:mm:ss')
                        });
                })
                .catch(function (err) {
                    if (errors.utils.isIgnitionError(err)) {
                        throw err;
                    }

                    throw new errors.LockError({
                        message: 'Error while acquire the migration lock.',
                        err: err
                    });
                });
        });
    }

    isLocked() {
        return this.connection('migrations_lock')
            .where({
                lock_key: 'km01'
            })
            .then(function (data) {
                if (!data || !data.length || data[0].locked) {
                    throw new errors.MigrationsAreLockedError({
                        message: 'Migration lock was never released or currently a migration is running.',
                        help: 'If you are sure no migration is running, check your data and if your database is in a broken state, you could run `knex-migrator rollback`.'
                    });
                }

                return false;
            });
    }

    unlock() {
        let self = this;
        debug('Unlock.');

        return self.createTransaction(function (transacting) {
            return transacting('migrations_lock')
                .where({
                    lock_key: 'km01'
                })
                .forUpdate()
                .then(function (data) {
                    if (!data || !data.length || !data[0].locked) {
                        throw new errors.MigrationsAreLockedError({
                            message: 'Migration lock was already released?.'
                        });
                    }

                    return transacting('migrations_lock')
                        .where({
                            lock_key: 'km01'
                        })
                        .update({
                            locked: 0,
                            released_at: moment().format('YYYY-MM-DD HH:mm:ss')
                        });
                })
                .catch(function (err) {
                    if (errors.utils.isIgnitionError(err)) {
                        throw err;
                    }

                    throw new errors.UnlockError({
                        message: 'Error while releasing the migration lock.',
                        err: err
                    });
                });
        });
    }

    afterEach(options) {
        options = options || {};

        let self = this;
        let task = options.task;
        let version = options.version;

        return this.connection('migrations')
            .insert({
                name: task.name,
                version: version,
                currentVersion: self.currentVersion
            });
    }

    createTransaction(callback) {
        return this.connection.transaction(callback);
    }

    /**
     * returns expected and actual database state
     * @TODO: refactor
     */
    integrityCheck(options) {
        options = options || {};

        let self = this,
            subfolder = this.subfolder,
            force = options.force,
            folders = [],
            currentVersionInitTask,
            operations = {},
            toReturn = {},
            futureVersions = [];

        // CASE: we always fetch the init scripts and check them
        // 1. to be able to add more init scripts
        // 2. to check if migration scripts need's to be executed or not, see https://github.com/TryGhost/knex-migrator/issues/39
        folders.push('init');

        // CASE: no subfolder yet
        try {
            folders = folders.concat(utils.readFolders(path.join(self.migrationPath, subfolder)));
        } catch (err) {
            // ignore
        }

        _.each(folders, function (folder) {
            // CASE: versions/1.1-members or versions/2.0-payments
            if (folder !== 'init') {
                try {
                    folder = folder.match(/([\d._]+)/)[0];
                } catch (err) {
                    logging.warn('Cannot parse folder name.');
                    logging.warn('Ignore Folder: ' + folder);
                    return;
                }
            }

            // CASE:
            // if your current version is 1.0 and you add migration scripts for the next version 1.1
            // we won't execute them until your current version changes to 1.1 or until you force KM to migrate to it
            if (self.currentVersion && !force) {
                if (utils.isGreaterThanVersion({smallerVersion: self.currentVersion, greaterVersion: folder})) {
                    futureVersions.push(folder);
                }
            }

            operations[folder] = self.connection('migrations').where({
                version: folder
            }).catch(function onMigrationsLookupError(err) {
                // CASE: no database selected (database.connection.database="")
                if (err.errno === 1046) {
                    throw new errors.DatabaseIsNotOkError({
                        message: 'Please define a target database in your configuration.',
                        help: 'database: {\n\tconnection:\n\t\tdatabase:"database_name"\n\t}\n}\n',
                        code: 'DB_NOT_INITIALISED'
                    });
                }

                // CASE: database does not exist
                if (err.errno === 1049) {
                    throw new errors.DatabaseIsNotOkError({
                        message: 'Please run knex-migrator init',
                        code: 'DB_NOT_INITIALISED'
                    });
                }

                // CASE: migration table does not exist
                if (err.errno === 1 || err.errno === 1146) {
                    throw new errors.DatabaseIsNotOkError({
                        message: 'Please run knex-migrator init',
                        code: 'MIGRATION_TABLE_IS_MISSING'
                    });
                }

                throw err;
            });
        });

        return Promise.props(operations)
            .then(function (result) {
                _.each(result, function (value, version) {
                    let actual = value.length,
                        expected = actual;

                    // CASE: remember the version the user has initialised the database
                    if (version === 'init') {
                        currentVersionInitTask = value.length && value[0].currentVersion;
                    }

                    if (version !== 'init') {
                        if (utils.isGreaterThanVersion({smallerVersion: currentVersionInitTask, greaterVersion: version})) {
                            expected = utils.readTasks(path.join(self.migrationPath, subfolder, version)).length;
                        }
                    } else {
                        expected = utils.readTasks(path.join(self.migrationPath, version)).length;
                    }

                    debug('Version ' + version + ' expected: ' + expected);
                    debug('Version ' + version + ' actual: ' + actual);

                    toReturn[version] = {
                        expected: expected,
                        actual: actual
                    }
                });


                // CASE: ensure that either you have to run `migrate --force` or they ran already
                if (futureVersions.length) {
                    _.each(futureVersions, function (futureVersion) {
                        if (toReturn[futureVersion].actual !== toReturn[futureVersion].expected) {
                            logging.warn('knex-migrator is skipping ' + futureVersion);
                            logging.warn('Current version in MigratorConfig.js is smaller then requested version, use --force to proceed!');
                            logging.warn('Please run `knex-migrator migrate --v ' + futureVersion + ' --force` to proceed!');
                            delete toReturn[futureVersion];
                        }
                    });
                }

                return toReturn;
            });
    }

    /**
     * Gives you two informations:
     * 1. is your database initialised?
     * 2. does your database needs a migration?
     */
    isDatabaseOK() {
        let self = this;
        this.connection = database.connect(this.dbConfig);

        return this.runDatabaseUpgrades()
            .then(function () {
                return self.isLocked();
            })
            .then(function () {
                return self.integrityCheck();
            })
            .then(function (result) {
                // CASE: if an init script was removed, the health check will be positive (see #48)
                if (result.init && result.init.expected > result.init.actual) {
                    throw new errors.DatabaseIsNotOkError({
                        message: 'Please run knex-migrator init',
                        code: 'DB_NOT_INITIALISED'
                    });
                }

                _.each(_.omit(result, 'init'), function (value) {
                    // CASE: there are more migrations expected than have been run, database needs to be migrated
                    if (value.expected > value.actual) {
                        throw new errors.DatabaseIsNotOkError({
                            message: 'Migrations are missing. Please run knex-migrator migrate.',
                            code: 'DB_NEEDS_MIGRATION'
                        });
                        // CASE: there are more actual migrations than expected, something has gone wrong :(
                    } else if (value.expected < value.actual) {
                        throw new errors.DatabaseIsNotOkError({
                            message: 'Detected more items in the migrations table than expected. Please manually inspect the migrations table.',
                            code: 'MIGRATION_STATE_ERROR'
                        });
                    }
                });
            })
            .catch(function (err) {
                // CASE: database does not exist
                if (err.errno === 1049) {
                    throw new errors.DatabaseIsNotOkError({
                        message: 'Please run knex-migrator init',
                        code: 'DB_NOT_INITIALISED'
                    });
                }

                throw err;
            })
            .finally(function () {
                if (!self.connection) {
                    return;
                }

                debug('Destroy connection');
                return self.connection.destroy()
                    .then(function () {
                        debug('Destroyed connection');
                    });
            });
    }

    // @TODO: support a specific version to roll back
    /**
     * By default, rollback is only allowed when your database is locked.
     * You can pass `--force` to skip this.
     * @param options
     */
    rollback(options) {
        options = options || {};

        let self = this;
        let force = options.force;
        let disableHooks = options.disableHooks;
        let hooks = {};

        this.connection = database.connect(this.dbConfig);

        const helper = function helper() {
            return new Promise(function (resolve, reject) {
                try {
                    if (!disableHooks) {
                        // @TODO: load init or migrate hooks
                        hooks = require(path.join(self.migrationPath, '/hooks/init'));
                    }
                } catch (err) {
                    debug('Hook Error: ' + err.message);
                    debug('No hooks found, no problem.');
                }

                if (hooks.before) {
                    return hooks.before({
                        connection: self.connection
                    }).then(resolve).catch(reject);
                }

                resolve();
            }).then(function () {
                return self.connection('migrations')
                    .where({
                        currentVersion: self.currentVersion
                    })
                    .then(function (values) {
                        if (!values.length) {
                            throw new errors.IncorrectUsageError({
                                message: 'No migrations available to rollback.'
                            });
                        }

                        values.reverse();
                        return Promise.each(values, function (value) {
                            return self._rollback({
                                version: value.version,
                                onlyTasks: [value.name]
                            });
                        });
                    });
            }).then(function () {
                if (hooks.shutdown) {
                    return hooks.shutdown();
                }
            })
        };

        return this.runDatabaseUpgrades()
            .then(function () {
                return self.isLocked();
            })
            .then(function () {
                // db is not locked, force
                if (force) {
                    return helper();
                }

                throw new errors.IncorrectUsageError({
                    message: 'Rollback did not happen.',
                    help: 'Use --force if you want to force a rollback. By default, rollbacks are only allowed if your database is locked.'
                });
            })
            .catch(function (err) {
                if (err instanceof errors.MigrationsAreLockedError) {
                    return helper()
                        .then(function () {
                            return self.unlock();
                        });
                }

                throw err;
            })
            .finally(function () {
                if (!self.connection) {
                    return;
                }

                debug('Destroy connection');
                return self.connection.destroy()
                    .then(function () {
                        debug('Destroyed connection');
                    });
            });
    }
}
module.exports = KnexMigrator;

