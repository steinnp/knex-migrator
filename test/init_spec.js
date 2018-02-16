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
    })

    it('Should return a config if it has been declared', function() {
        const configOptions = { test: 'test' };
        const config = KnexMigrator.prototype._loadConfig({ knexMigratorConfig: configOptions });
        config.should.eql(configOptions);
    })

})