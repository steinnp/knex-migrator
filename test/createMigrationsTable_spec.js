'use strict';

const path = require('path'),
    knex = require('knex'),
    sinon = require('sinon'),
    should = require('should'),
    fs = require('fs'),
    KnexMigrator = require('../lib'),
    database = require('../lib/database'),
    config = require('../config'),
    errors = require('../lib/errors'),
    debug = require('debug')('knex-migrator:utils'),
    testUtils = require('./utils');

/*
describe('createMigrationsTable', function () {
    it('creates a migrations table if none exists', function () {
            const configStub = sinon.stub(KnexMigrator.prototype, '_loadConfig');
            configStub.returns({
                database: { client: 'mysql' },
                migrationPath: 'testMigrationPath',
                currentVersion: '1.1',
                subfolder: 'testFolder',
            });

            const migrator = new KnexMigrator();
            migrator.createMigrationsTable();

            configStub.restore();
    });
});
*/