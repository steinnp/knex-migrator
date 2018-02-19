/**
 * knex-migrator init
 */
/*
KnexMigrator.prototype.init = function init(options) {
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
};
*/

