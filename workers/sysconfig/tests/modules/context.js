var expect = require('chai').expect;
var Context = require('nef/sysconfig/Context');

module.exports = function test() {
    var self = this;

    describe('Context', function() {
        var ctx = undefined;

        beforeEach('init context', function() {
            ctx = new Context({
                type: 'set',
                name: 'Some caller',
                args: {
                    optArg: true
                }
            });
        });

        it('should have right defaults', function() {
            expect(ctx.type).to.be.equal('set');
            expect(ctx.name).to.be.equal('Some caller');
            expect(ctx.global).to.be.defined;
            expect(ctx.args).to.be.deep.equal({
                optArg: true
            });
        });

        it('should properly create new layer, work with it', function() {
            var first = ctx.fork('first', {
                someProp: 'some val'
            });
            first.anotherProp = 'another val';

            // New layer should have new local data
            expect(first.someProp).to.be.equal('some val');
            expect(first.anotherProp).to.be.equal('another val');

            // Should still have global data
            expect(first.type).to.be.equal('set');
            expect(first.name).to.be.equal('Some caller');

            // Root layer should not have layers data
            expect(ctx.someProp).to.be.undefined;
            expect(ctx.anotherProp).to.be.undefined;

            // Should still have global data
            expect(ctx.type).to.be.equal('set');
            expect(ctx.name).to.be.equal('Some caller');

        });

        it('should persist data in ctx.global between layers', function() {
            // Push first layer, update global hash
            var first = ctx.fork('first', {});
            var second = ctx.fork('second', {});
            var firstCh = first.fork('firstCh', {});

            ctx.global.newProp = 'value';
            first.global.firstProp = 'value';
            second.global.secondProp  = 'value';
            firstCh.global.firstChProp = 'value';

            for (var obj of [ctx, first, second, firstCh]) {
                expect(obj.global).to.be.deep.equal({
                    newProp: 'value',
                    firstProp: 'value',
                    secondProp: 'value',
                    firstChProp: 'value'
                });
            }
        });

        it('should properly isolate local data between layers', function() {
            var first = ctx.fork('first', {});
            var second = first.fork('second', {});

            ctx.common = 'base';
            first.common = 1;
            first.first = 1;
            second.common = 2;
            second.second = 2;

            expect(ctx.common).to.be.equal('base');
            expect(ctx.first).to.be.undefined;
            expect(ctx.second).to.be.undefined;

            expect(first.common).to.be.equal(1);
            expect(first.first).to.be.equal(1);
            expect(first.second).to.be.undefined;

            expect(second.common).to.be.equal(2);
            expect(second.first).to.be.undefined;
            expect(second.second).to.be.equal(2);
        });

        it('should properly hide underscored data in ctx.export()',
            function() {
            first = ctx.fork('first', {
                _hidden: 1,
                visible: 1
            });
            first._hidden2 = 2;
            first.visible2 = 2;

            var exported = first.export();

            expect(exported._hidden).to.be.undefined;
            expect(exported._hidden2).to.be.undefined;
            expect(exported._layerId).to.be.undefined;

            expect(exported.visible).to.be.equal(1);
            expect(exported.visible2).to.be.equal(2);
        });

        it('should not allow modification of layers, globals, or methods',
            function() {

            expect(() => {
                ctx.type = 'updated';
            }).to.throw(Error);

            expect(() => {
                ctx._layerId = {};
            }).to.throw(Error);

            expect(() => {
                ctx.keys = () => {return [];};
            }).to.throw(Error);
        });
    });
};
