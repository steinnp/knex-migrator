'use strict';

const path = require('path'),
    knex = require('knex'),
    sinon = require('sinon'),
    should = require('should'),
    fs = require('fs'),
    KnexMigrator = require('../lib'),
    config = require('../config'),
    errors = require('../lib/errors'),
    debug = require('debug')('knex-migrator:utils'),
    testUtils = require('./utils');


describe('knex-migrator init functionality', function () {
    describe('_loadConfig', function () {
        it('Should throw an error when initialising the function with no parameters', function () {
            (function () {
                KnexMigrator.prototype._loadConfig()
            }).should.throw();
        })

        it('Should throw an error when initialising the function with no values in the options', function () {
            (function () {
                KnexMigrator.prototype._loadConfig({})
            }).should.throw();
        })

        it('Should throw an error when requiring a non existent module', function () {
            const cwdStub = sinon.stub(process, 'cwd');
            cwdStub.returns('cwd');

            const resolveStub = sinon.stub(path, 'resolve');
            resolveStub.returns('resolved');

            const joinStub = sinon.stub(path, 'join');
            joinStub.returns('join');

            (function () {
                KnexMigrator.prototype._loadConfig({})
            }).should.throw();
            cwdStub.called.should.eql(true);
            resolveStub.calledWith('cwd').should.eql(true);
            joinStub.calledWith('resolved').should.eql(true);

            cwdStub.restore();
            resolveStub.restore();
            joinStub.restore();            
        })

        it('Should return a config if it has been declared', function () {
            const configOptions = { test: 'test' };
            const config = KnexMigrator.prototype._loadConfig({ knexMigratorConfig: configOptions });
            config.should.eql(configOptions);
        })
    })

    describe('Constructor', function () {
        it('should throw an error if no database is described in the migrator config', function () {
            const configStub = sinon.stub(KnexMigrator.prototype, '_loadConfig');
            configStub.returns({});

            (function () {
                new KnexMigrator();
            }).should.throw('MigratorConfig.js needs to export a database config.')

            configStub.restore();
        })

        it('should throw an error if no migrationPath is described in the migrator config', function () {
            const configStub = sinon.stub(KnexMigrator.prototype, '_loadConfig');
            configStub.returns({ database: 'testDatabase' });

            (function () {
                new KnexMigrator();
            }).should.throw('MigratorConfig.js needs to export the location of your migration files.')

            configStub.restore();
        })

        it('should throw an error if no current version is described in the migrator config', function () {
            const configStub = sinon.stub(KnexMigrator.prototype, '_loadConfig');
            configStub.returns({ database: 'testDatabase', migrationPath: 'testMigrationPath' });

            (function () {
                new KnexMigrator();
            }).should.throw('MigratorConfig.js needs to export the a current version.')

            configStub.restore();
        })

        it('should set the properties currentVersion, migrationPath, subfolder, dbConfig, isMySQL', function () {
            const configStub = sinon.stub(KnexMigrator.prototype, '_loadConfig');
            configStub.returns({
                database: { client: 'mysql' },
                migrationPath: 'testMigrationPath',
                currentVersion: '1.1',
                subfolder: 'testFolder',
            });

            const migrator = new KnexMigrator();

            migrator.currentVersion.should.eql('1.1');
            migrator.migrationPath.should.eql('testMigrationPath');
            migrator.subfolder.should.eql('testFolder');
            migrator.dbConfig.should.eql({ client: 'mysql' });
            migrator.isMySQL.should.eql(true);

            configStub.restore();
        })        
    })

})