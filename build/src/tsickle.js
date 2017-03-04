/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var ts = require("typescript");
var decorators_1 = require("./decorators");
var es5processor_1 = require("./es5processor");
var jsdoc = require("./jsdoc");
var rewriter_1 = require("./rewriter");
var typeTranslator = require("./type-translator");
var util_1 = require("./util");
var decorator_annotator_1 = require("./decorator-annotator");
exports.convertDecorators = decorator_annotator_1.convertDecorators;
var es5processor_2 = require("./es5processor");
exports.processES5 = es5processor_2.processES5;
var modules_manifest_1 = require("./modules_manifest");
exports.ModulesManifest = modules_manifest_1.ModulesManifest;
var tsickle_compiler_host_1 = require("./tsickle_compiler_host");
exports.Pass = tsickle_compiler_host_1.Pass;
exports.TsickleCompilerHost = tsickle_compiler_host_1.TsickleCompilerHost;
/**
 * Symbols that are already declared as externs in Closure, that should
 * be avoided by tsickle's "declare ..." => externs.js conversion.
 */
exports.closureExternsBlacklist = [
    'exports',
    'global',
    'module',
    // ErrorConstructor is the interface of the Error object itself.
    // tsickle detects that this is part of the TypeScript standard library
    // and assumes it's part of the Closure standard library, but this
    // assumption is wrong for ErrorConstructor.  To properly handle this
    // we'd somehow need to map methods defined on the ErrorConstructor
    // interface into properties on Closure's Error object, but for now it's
    // simpler to just blacklist it.
    'ErrorConstructor',
    'Symbol',
    'WorkerGlobalScope',
];
function formatDiagnostics(diags) {
    return diags
        .map(function (d) {
        var res = ts.DiagnosticCategory[d.category];
        if (d.file) {
            res += ' at ' + d.file.fileName + ':';
            var _a = d.file.getLineAndCharacterOfPosition(d.start), line = _a.line, character = _a.character;
            res += (line + 1) + ':' + (character + 1) + ':';
        }
        res += ' ' + ts.flattenDiagnosticMessageText(d.messageText, '\n');
        return res;
    })
        .join('\n');
}
exports.formatDiagnostics = formatDiagnostics;
/** @return true if node has the specified modifier flag set. */
function hasModifierFlag(node, flag) {
    return (ts.getCombinedModifierFlags(node) & flag) !== 0;
}
/**
 * TypeScript allows you to write identifiers quoted, like:
 *   interface Foo {
 *     'bar': string;
 *     'complex name': string;
 *   }
 *   Foo.bar;  // ok
 *   Foo['bar']  // ok
 *   Foo['complex name']  // ok
 *
 * In Closure-land, we want identify that the legal name 'bar' can become an
 * ordinary field, but we need to skip strings like 'complex name'.
 */
function isValidClosurePropertyName(name) {
    // In local experimentation, it appears that reserved words like 'var' and
    // 'if' are legal JS and still accepted by Closure.
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
function isDtsFileName(fileName) {
    return /\.d\.ts$/.test(fileName);
}
exports.isDtsFileName = isDtsFileName;
/** Returns the Closure name of a function parameter, special-casing destructuring. */
function getParameterName(param, index) {
    switch (param.name.kind) {
        case ts.SyntaxKind.Identifier:
            var name_1 = rewriter_1.getIdentifierText(param.name);
            // TypeScript allows parameters named "arguments", but Closure
            // disallows this, even in externs.
            if (name_1 === 'arguments')
                name_1 = 'tsickle_arguments';
            return name_1;
        case ts.SyntaxKind.ArrayBindingPattern:
        case ts.SyntaxKind.ObjectBindingPattern:
            // Closure crashes if you put a binding pattern in the externs.
            // Avoid this by just generating an unused name; the name is
            // ignored anyway.
            return "__" + index;
        default:
            // The above list of kinds is exhaustive.  param.name is 'never' at this point.
            var paramName = param.name;
            throw new Error("unhandled function parameter kind: " + ts.SyntaxKind[paramName.kind]);
    }
}
var VISIBILITY_FLAGS = ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Public;
/**
 * A Rewriter subclass that adds Tsickle-specific (Closure translation) functionality.
 *
 * One Rewriter subclass manages .ts => .ts+Closure translation.
 * Another Rewriter subclass manages .ts => externs translation.
 */
var ClosureRewriter = (function (_super) {
    __extends(ClosureRewriter, _super);
    function ClosureRewriter(program, file, options) {
        var _this = _super.call(this, file) || this;
        _this.program = program;
        _this.options = options;
        /**
         * A mapping of aliases for symbols in the current file, used when emitting types.
         * TypeScript emits imported symbols with unpredictable prefixes. To generate correct type
         * annotations, tsickle creates its own aliases for types, and registers them in this map (see
         * `emitImportDeclaration` and `forwardDeclare()` below). The aliases are then used when emitting
         * types.
         */
        _this.symbolsToAliasedNames = new Map();
        return _this;
    }
    /**
     * Handles emittng the jsdoc for methods, including overloads.
     * If overloaded, merges the signatures in the list of SignatureDeclarations into a single jsdoc.
     * - Total number of parameters will be the maximum count found across all variants.
     * - Different names at the same parameter index will be joined with "_or_"
     * - Variable args (...type[] in TypeScript) will be output as "...type",
     *    except if found at the same index as another argument.
     * @param  fnDecls Pass > 1 declaration for overloads of same name
     * @return The list of parameter names that should be used to emit the actual
     *    function statement; for overloads, name will have been merged.
     */
    ClosureRewriter.prototype.emitFunctionType = function (fnDecls, extraTags) {
        if (extraTags === void 0) { extraTags = []; }
        var typeChecker = this.program.getTypeChecker();
        var newDoc = extraTags;
        var lens = fnDecls.map(function (fnDecl) { return fnDecl.parameters.length; });
        var minArgsCount = Math.min.apply(Math, lens);
        var maxArgsCount = Math.max.apply(Math, lens);
        var isConstructor = fnDecls.find(function (d) { return d.kind === ts.SyntaxKind.Constructor; }) !== undefined;
        // For each parameter index i, paramTags[i] is an array of parameters
        // that can be found at index i.  E.g.
        //    function foo(x: string)
        //    function foo(y: number, z: string)
        // then paramTags[0] = [info about x, info about y].
        var paramTags = [];
        var returnTags = [];
        for (var _i = 0, fnDecls_1 = fnDecls; _i < fnDecls_1.length; _i++) {
            var fnDecl = fnDecls_1[_i];
            // Construct the JSDoc comment by reading the existing JSDoc, if
            // any, and merging it with the known types of the function
            // parameters and return type.
            var jsDoc = this.getJSDoc(fnDecl) || [];
            // Copy all the tags other than @param/@return into the new
            // JSDoc without any change; @param/@return are handled specially.
            // TODO: there may be problems if an annotation doesn't apply to all overloads;
            // is it worth checking for this and erroring?
            for (var _a = 0, jsDoc_1 = jsDoc; _a < jsDoc_1.length; _a++) {
                var tag = jsDoc_1[_a];
                if (tag.tagName === 'param' || tag.tagName === 'return')
                    continue;
                newDoc.push(tag);
            }
            // Add @abstract on "abstract" declarations.
            if (hasModifierFlag(fnDecl, ts.ModifierFlags.Abstract)) {
                newDoc.push({ tagName: 'abstract' });
            }
            // Merge the parameters into a single list of merged names and list of types
            var sig = typeChecker.getSignatureFromDeclaration(fnDecl);
            for (var i = 0; i < sig.declaration.parameters.length; i++) {
                var paramNode = sig.declaration.parameters[i];
                var name_2 = getParameterName(paramNode, i);
                var isThisParam = name_2 === 'this';
                var newTag = {
                    tagName: isThisParam ? 'this' : 'param',
                    optional: paramNode.initializer !== undefined || paramNode.questionToken !== undefined,
                    parameterName: isThisParam ? undefined : name_2,
                };
                var type = typeChecker.getTypeAtLocation(paramNode);
                if (paramNode.dotDotDotToken !== undefined) {
                    newTag.restParam = true;
                    // In TypeScript you write "...x: number[]", but in Closure
                    // you don't write the array: "@param {...number} x".  Unwrap
                    // the Array<> wrapper.
                    type = type.typeArguments[0];
                }
                newTag.type = this.typeToClosure(fnDecl, type);
                for (var _b = 0, jsDoc_2 = jsDoc; _b < jsDoc_2.length; _b++) {
                    var _c = jsDoc_2[_b], tagName = _c.tagName, parameterName = _c.parameterName, text = _c.text;
                    if (tagName === 'param' && parameterName === newTag.parameterName) {
                        newTag.text = text;
                        break;
                    }
                }
                if (!paramTags[i])
                    paramTags.push([]);
                paramTags[i].push(newTag);
            }
            // Return type.
            if (!isConstructor) {
                var retType = typeChecker.getReturnTypeOfSignature(sig);
                var retTypeString = this.typeToClosure(fnDecl, retType);
                var returnDoc = void 0;
                for (var _d = 0, jsDoc_3 = jsDoc; _d < jsDoc_3.length; _d++) {
                    var _e = jsDoc_3[_d], tagName = _e.tagName, text = _e.text;
                    if (tagName === 'return') {
                        returnDoc = text;
                        break;
                    }
                }
                returnTags.push({
                    tagName: 'return',
                    type: retTypeString,
                    text: returnDoc,
                });
            }
        }
        // Merge the JSDoc tags for each overloaded parameter.
        // Ensure each parameter has a unique name; the merging process can otherwise
        // accidentally generate the same parameter name twice.
        var paramNames = new Set();
        var foundOptional = false;
        for (var i = 0; i < maxArgsCount; i++) {
            var paramTag = jsdoc.merge(paramTags[i]);
            if (paramNames.has(paramTag.parameterName)) {
                paramTag.parameterName += i.toString();
            }
            paramNames.add(paramTag.parameterName);
            // If the tag is optional, mark parameters following optional as optional,
            // even if they are not, since Closure restricts this, see
            // https://github.com/google/closure-compiler/issues/2314
            if (!paramTag.restParam && (paramTag.optional || foundOptional || i >= minArgsCount)) {
                foundOptional = true;
                paramTag.optional = true;
            }
            newDoc.push(paramTag);
            if (paramTag.restParam) {
                // Cannot have any parameters after a rest param.
                // Just dump the remaining parameters.
                break;
            }
        }
        // Merge the JSDoc tags for each overloaded return.
        if (!isConstructor) {
            newDoc.push(jsdoc.merge(returnTags));
        }
        this.emit('\n' + jsdoc.toString(newDoc));
        return newDoc.filter(function (t) { return t.tagName === 'param'; }).map(function (t) { return t.parameterName; });
    };
    /**
     * Returns null if there is no existing comment.
     */
    ClosureRewriter.prototype.getJSDoc = function (node) {
        var text = node.getFullText();
        var comments = ts.getLeadingCommentRanges(text, 0);
        if (!comments || comments.length === 0)
            return null;
        // JS compiler only considers the last comment significant.
        var _a = comments[comments.length - 1], pos = _a.pos, end = _a.end;
        var comment = text.substring(pos, end);
        var parsed = jsdoc.parse(comment);
        if (!parsed)
            return null;
        if (parsed.warnings) {
            var start = node.getFullStart() + pos;
            this.diagnostics.push({
                file: this.file,
                start: start,
                length: node.getStart() - start,
                messageText: parsed.warnings.join('\n'),
                category: ts.DiagnosticCategory.Warning,
                code: 0,
            });
        }
        return parsed.tags;
    };
    /** Emits a type annotation in JSDoc, or {?} if the type is unavailable. */
    ClosureRewriter.prototype.emitJSDocType = function (node, additionalDocTag, type) {
        this.emit(' /**');
        if (additionalDocTag) {
            this.emit(' ' + additionalDocTag);
        }
        this.emit(" @type {" + this.typeToClosure(node, type) + "} */");
    };
    /**
     * Convert a TypeScript ts.Type into the equivalent Closure type.
     *
     * @param context The ts.Node containing the type reference; used for resolving symbols
     *     in context.
     * @param type The type to translate; if not provided, the Node's type will be used.
     */
    ClosureRewriter.prototype.typeToClosure = function (context, type) {
        var _this = this;
        if (this.options.untyped) {
            return '?';
        }
        var typeChecker = this.program.getTypeChecker();
        if (!type) {
            type = typeChecker.getTypeAtLocation(context);
        }
        var translator = new typeTranslator.TypeTranslator(typeChecker, context, this.options.typeBlackListPaths, this.symbolsToAliasedNames);
        translator.warn = function (msg) { return _this.debugWarn(context, msg); };
        return translator.translate(type);
    };
    /**
     * debug logs a debug warning.  These should only be used for cases
     * where tsickle is making a questionable judgement about what to do.
     * By default, tsickle does not report any warnings to the caller,
     * and warnings are hidden behind a debug flag, as warnings are only
     * for tsickle to debug itself.
     */
    ClosureRewriter.prototype.debugWarn = function (node, messageText) {
        if (!this.options.logWarning)
            return;
        // Use a ts.Diagnosic so that the warning includes context and file offets.
        var diagnostic = {
            file: this.file,
            start: node.getStart(),
            length: node.getEnd() - node.getStart(), messageText: messageText,
            category: ts.DiagnosticCategory.Warning,
            code: 0,
        };
        this.options.logWarning(diagnostic);
    };
    return ClosureRewriter;
}(rewriter_1.Rewriter));
/** Annotator translates a .ts to a .ts with Closure annotations. */
var Annotator = (function (_super) {
    __extends(Annotator, _super);
    function Annotator(program, file, options, pathToModuleName, host, tsOpts) {
        var _this = _super.call(this, program, file, options) || this;
        _this.pathToModuleName = pathToModuleName;
        _this.host = host;
        _this.tsOpts = tsOpts;
        /** Exported symbol names that have been generated by expanding an "export * from ...". */
        _this.generatedExports = new Set();
        /** Externs determined by an exporting decorator. */
        _this.exportingDecoratorExterns = [];
        _this.forwardDeclareCounter = 0;
        _this.externsWriter = new ExternsWriter(program, file, options);
        return _this;
    }
    Annotator.prototype.annotate = function () {
        this.visit(this.file);
        var externs = this.externsWriter.getOutput();
        var annotated = this.getOutput();
        var externsSource = null;
        if (externs.output.length > 0 || this.exportingDecoratorExterns.length > 0) {
            externsSource = "/**\n * @externs\n * @suppress {duplicate}\n */\n// NOTE: generated by tsickle, do not edit.\n" + externs.output +
                this.formatExportingDecoratorExterns();
        }
        return {
            output: annotated.output,
            externs: externsSource,
            diagnostics: externs.diagnostics.concat(annotated.diagnostics),
            sourceMap: annotated.sourceMap,
        };
    };
    Annotator.prototype.getExportDeclarationNames = function (node) {
        var _this = this;
        switch (node.kind) {
            case ts.SyntaxKind.VariableStatement:
                var varDecl = node;
                return varDecl.declarationList.declarations.map(function (d) { return _this.getExportDeclarationNames(d)[0]; });
            case ts.SyntaxKind.VariableDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.ClassDeclaration:
                var decl = node;
                if (!decl.name || decl.name.kind !== ts.SyntaxKind.Identifier) {
                    break;
                }
                return [decl.name];
            case ts.SyntaxKind.TypeAliasDeclaration:
                var typeAlias = node;
                return [typeAlias.name];
            default:
                break;
        }
        this.error(node, "unsupported export declaration " + ts.SyntaxKind[node.kind] + ": " + node.getText());
        return [];
    };
    /**
     * Emits an ES6 export for the ambient declaration behind node, if it is indeed exported.
     */
    Annotator.prototype.maybeEmitAmbientDeclarationExport = function (node) {
        // In TypeScript, `export declare` simply generates no code in the exporting module, but does
        // generate a regular import in the importing module.
        // For Closure Compiler, such declarations must still be exported, so that importing code in
        // other modules can reference them. Because tsickle generates global symbols for such types,
        // the appropriate semantics are referencing the global name.
        if (this.options.untyped || !hasModifierFlag(node, ts.ModifierFlags.Export)) {
            return;
        }
        var declNames = this.getExportDeclarationNames(node);
        for (var _i = 0, declNames_1 = declNames; _i < declNames_1.length; _i++) {
            var decl = declNames_1[_i];
            var sym = this.program.getTypeChecker().getSymbolAtLocation(decl);
            var isValue = sym.flags & ts.SymbolFlags.Value;
            var declName = rewriter_1.getIdentifierText(decl);
            if (node.kind === ts.SyntaxKind.VariableStatement) {
                // For variables, TypeScript rewrites every reference to the variable name as an
                // "exports." access, to maintain mutable ES6 exports semantics. Indirecting through the
                // window object means we reference the correct global symbol. Closure Compiler does
                // understand that "var foo" in externs corresponds to "window.foo".
                this.emit("\nexports." + declName + " = window." + declName + ";\n");
            }
            else if (!isValue) {
                // Non-value objects do not exist at runtime, so we cannot access the symbol (it only
                // exists in externs). Export them as a typedef, which forwards to the type in externs.
                this.emit("\n/** @typedef {" + declName + "} */\nexports." + declName + ";\n");
            }
            else {
                this.emit("\nexports." + declName + " = " + declName + ";\n");
            }
        }
    };
    Annotator.prototype.formatExportingDecoratorExterns = function () {
        if (this.exportingDecoratorExterns.length === 0) {
            return '';
        }
        return '\n' + this.exportingDecoratorExterns.map(function (name) { return "var " + name + ";\n"; }).join('');
    };
    /**
     * Examines a ts.Node and decides whether to do special processing of it for output.
     *
     * @return True if the ts.Node has been handled, false if we should
     *     emit it as is and visit its children.
     */
    Annotator.prototype.maybeProcess = function (node) {
        if (hasModifierFlag(node, ts.ModifierFlags.Ambient) || isDtsFileName(this.file.fileName)) {
            this.externsWriter.visit(node);
            // An ambient declaration declares types for TypeScript's benefit, so we want to skip Tsickle
            // conversion of its contents.
            this.writeRange(node.getFullStart(), node.getEnd());
            // ... but it might need to be exported for downstream importing code.
            this.maybeEmitAmbientDeclarationExport(node);
            return true;
        }
        if (decorators_1.hasExportingDecorator(node, this.program.getTypeChecker())) {
            var name_3 = node.name;
            if (name_3) {
                this.exportingDecoratorExterns.push(name_3.getText());
            }
        }
        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                return this.emitImportDeclaration(node);
            case ts.SyntaxKind.ExportDeclaration:
                var exportDecl = node;
                this.writeRange(node.getFullStart(), node.getStart());
                this.emit('export');
                var exportedSymbols = [];
                var typeChecker_1 = this.program.getTypeChecker();
                if (!exportDecl.exportClause && exportDecl.moduleSpecifier) {
                    // It's an "export * from ..." statement.
                    // Rewrite it to re-export each exported symbol directly.
                    exportedSymbols = this.expandSymbolsFromExportStar(exportDecl);
                    this.emit(" {" + exportedSymbols.map(function (e) { return rewriter_1.unescapeName(e.name); }).join(',') + "}");
                }
                else {
                    if (exportDecl.exportClause) {
                        exportedSymbols =
                            exportDecl.exportClause.elements.map(function (e) { return typeChecker_1.getSymbolAtLocation(e.name); });
                        this.visit(exportDecl.exportClause);
                    }
                }
                if (exportDecl.moduleSpecifier) {
                    this.emit(" from '" + this.resolveModuleSpecifier(exportDecl.moduleSpecifier) + "';");
                    this.forwardDeclare(exportDecl.moduleSpecifier, exportedSymbols);
                }
                else {
                    // export {...};
                    this.emit(';');
                }
                if (exportedSymbols.length) {
                    this.emitTypeDefExports(exportedSymbols);
                }
                return true;
            case ts.SyntaxKind.InterfaceDeclaration:
                this.emitInterface(node);
                // Emit the TS interface verbatim, with no tsickle processing of properties.
                this.writeRange(node.getFullStart(), node.getEnd());
                return true;
            case ts.SyntaxKind.VariableDeclaration:
                var varDecl = node;
                // Only emit a type annotation when it's a plain variable and
                // not a binding pattern, as Closure doesn't(?) have a syntax
                // for annotating binding patterns.  See issue #128.
                if (varDecl.name.kind === ts.SyntaxKind.Identifier) {
                    this.emitJSDocType(varDecl);
                }
                return false;
            case ts.SyntaxKind.ClassDeclaration:
                var classNode = node;
                this.visitClassDeclaration(classNode);
                return true;
            case ts.SyntaxKind.PublicKeyword:
            case ts.SyntaxKind.PrivateKeyword:
                // The "public"/"private" keywords are encountered in two places:
                // 1) In class fields (which don't appear in the transformed output).
                // 2) In "parameter properties", e.g.
                //      constructor(/** @export */ public foo: string).
                // In case 2 it's important to not emit that JSDoc in the generated
                // constructor, as this is illegal for Closure.  It's safe to just
                // always skip comments preceding the 'public' keyword.
                // See test_files/parameter_properties.ts.
                this.writeNode(node, /* skipComments */ true);
                return true;
            case ts.SyntaxKind.Constructor:
                var ctor = node;
                this.emitFunctionType([ctor]);
                // Write the "constructor(...) {" bit, but iterate through any
                // parameters if given so that we can examine them more closely.
                var offset = ctor.getStart();
                if (ctor.parameters.length) {
                    for (var _i = 0, _a = ctor.parameters; _i < _a.length; _i++) {
                        var param = _a[_i];
                        this.writeRange(offset, param.getFullStart());
                        this.visit(param);
                        offset = param.getEnd();
                    }
                }
                this.writeRange(offset, node.getEnd());
                return true;
            case ts.SyntaxKind.ArrowFunction:
                // It's difficult to annotate arrow functions due to a bug in
                // TypeScript (see tsickle issue 57).  For now, just pass them
                // through unannotated.
                return false;
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
                var fnDecl = node;
                if (!fnDecl.body) {
                    if (hasModifierFlag(fnDecl, ts.ModifierFlags.Abstract)) {
                        this.emitFunctionType([fnDecl]);
                        // Abstract functions look like
                        //   abstract foo();
                        // Emit the function as normal, except:
                        // - remove the "abstract"
                        // - change the return type to "void"
                        // - replace the trailing semicolon with an empty block {}
                        // To do so, skip all modifiers before the function name, and
                        // emit up to the end of the parameter list / return type.
                        if (!fnDecl.name) {
                            // Can you even have an unnamed abstract function?
                            this.error(fnDecl, 'anonymous abstract function');
                            return false;
                        }
                        this.writeRange(fnDecl.name.getStart(), fnDecl.parameters.end);
                        this.emit(') {}');
                        return true;
                    }
                    // Functions are allowed to not have bodies in the presence
                    // of overloads.  It's not clear how to translate these overloads
                    // into Closure types, so skip them for now.
                    return false;
                }
                this.emitFunctionType([fnDecl]);
                this.writeRange(fnDecl.getStart(), fnDecl.body.getFullStart());
                this.visit(fnDecl.body);
                return true;
            case ts.SyntaxKind.TypeAliasDeclaration:
                this.writeNode(node);
                this.visitTypeAlias(node);
                return true;
            case ts.SyntaxKind.EnumDeclaration:
                return this.maybeProcessEnum(node);
            case ts.SyntaxKind.TypeAssertionExpression:
            case ts.SyntaxKind.AsExpression:
                // Both of these cases are AssertionExpressions.
                var typeAssertion = node;
                this.emitJSDocType(typeAssertion);
                // When TypeScript emits JS, it removes one layer of "redundant"
                // parens, but we need them for the Closure type assertion.  Work
                // around this by using two parens.  See test_files/coerce.*.
                // TODO: the comment is currently dropped from pure assignments due to
                //   https://github.com/Microsoft/TypeScript/issues/9873
                this.emit('((');
                this.writeNode(node);
                this.emit('))');
                return true;
            case ts.SyntaxKind.NonNullExpression:
                var nnexpr = node;
                var type = this.program.getTypeChecker().getTypeAtLocation(nnexpr.expression);
                if (type.flags & ts.TypeFlags.Union) {
                    var nonNullUnion = type
                        .types.filter(function (t) { return (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0; });
                    var typeCopy = Object.assign({}, type);
                    typeCopy.types = nonNullUnion;
                    type = typeCopy;
                }
                this.emitJSDocType(nnexpr, undefined, type);
                // See comment above.
                this.emit('((');
                this.writeNode(nnexpr.expression);
                this.emit('))');
                return true;
            case ts.SyntaxKind.PropertyDeclaration:
            case ts.SyntaxKind.VariableStatement:
                var jsDoc = this.getJSDoc(node);
                if (jsDoc && jsDoc.length > 0 && node.getFirstToken()) {
                    this.emit('\n');
                    this.emit(jsdoc.toString(jsDoc));
                    this.writeRange(node.getFirstToken().getStart(), node.getEnd());
                    return true;
                }
                break;
            default:
                break;
        }
        return false;
    };
    /**
     * Given a "export * from ..." statement, gathers the symbol names it actually
     * exports to be used in a statement like "export {foo, bar, baz} from ...".
     *
     * This is necessary because TS transpiles "export *" by just doing a runtime loop
     * over the target module's exports, which means Closure won't see the declarations/types
     * that are exported.
     */
    Annotator.prototype.expandSymbolsFromExportStar = function (exportDecl) {
        // You can't have an "export *" without a module specifier.
        var moduleSpecifier = exportDecl.moduleSpecifier;
        var typeChecker = this.program.getTypeChecker();
        // Gather the names of local exports, to avoid reexporting any
        // names that are already locally exported.
        // To find symbols declared like
        //   export {foo} from ...
        // we must also query for "Alias", but that unfortunately also brings in
        //   import {foo} from ...
        // so the latter is filtered below.
        var locals = typeChecker.getSymbolsInScope(this.file, ts.SymbolFlags.Export | ts.SymbolFlags.Alias);
        var localSet = new Set();
        for (var _i = 0, locals_1 = locals; _i < locals_1.length; _i++) {
            var local = locals_1[_i];
            if (local.declarations &&
                local.declarations.some(function (d) { return d.kind === ts.SyntaxKind.ImportSpecifier; })) {
                continue;
            }
            localSet.add(local.name);
        }
        // Expand the export list, then filter it to the symbols we want to reexport.
        var exports = typeChecker.getExportsOfModule(typeChecker.getSymbolAtLocation(moduleSpecifier));
        var reexports = new Set();
        for (var _a = 0, exports_1 = exports; _a < exports_1.length; _a++) {
            var sym = exports_1[_a];
            var name_4 = rewriter_1.unescapeName(sym.name);
            if (localSet.has(name_4)) {
                // This name is shadowed by a local definition, such as:
                // - export var foo ...
                // - export {foo} from ...
                continue;
            }
            if (this.generatedExports.has(name_4)) {
                // Already exported via an earlier expansion of an "export * from ...".
                continue;
            }
            this.generatedExports.add(name_4);
            reexports.add(sym);
        }
        return util_1.toArray(reexports.keys());
    };
    /**
     * Write an `exports.` assignment for each type alias exported in the given `exports`.
     * TypeScript by itself does not export non-value symbols (e.g. interfaces, typedefs), as it
     * expects to remove those entirely for runtime. For Closure, types must be
     * exported as downstream code will import the type.
     *
     * The tsickle pass turns interfaces into values by generating a `function MyInterface() {}` for
     * them, so in the second conversion pass, TypeScript does export a value for them. However for
     * pure typedefs, tsickle only generates a property access with a JSDoc comment, so they need to
     * be exported explicitly here.
     */
    Annotator.prototype.emitTypeDefExports = function (exports) {
        if (this.options.untyped)
            return;
        var typeChecker = this.program.getTypeChecker();
        for (var _i = 0, exports_2 = exports; _i < exports_2.length; _i++) {
            var sym = exports_2[_i];
            if (sym.flags & ts.SymbolFlags.Alias)
                sym = typeChecker.getAliasedSymbol(sym);
            var isTypeAlias = (sym.flags & ts.SymbolFlags.TypeAlias) !== 0 && (sym.flags & ts.SymbolFlags.Value) === 0;
            if (!isTypeAlias)
                continue;
            var typeName = this.symbolsToAliasedNames.get(sym) || sym.name;
            this.emit("\n/** @typedef {" + typeName + "} */\nexports." + sym.name + "; // re-export typedef");
        }
    };
    /**
     * Convert from implicit `import {} from 'pkg'` to `import {} from 'pkg/index'.
     * TypeScript supports the shorthand, but not all ES6 module loaders do.
     * Workaround for https://github.com/Microsoft/TypeScript/issues/12597
     */
    Annotator.prototype.resolveModuleSpecifier = function (moduleSpecifier) {
        if (moduleSpecifier.kind !== ts.SyntaxKind.StringLiteral) {
            throw new Error("unhandled moduleSpecifier kind: " + ts.SyntaxKind[moduleSpecifier.kind]);
        }
        var moduleId = moduleSpecifier.text;
        if (this.options.convertIndexImportShorthand) {
            if (!this.tsOpts || !this.host) {
                throw new Error('option convertIndexImportShorthand requires that annotate be called with a TypeScript host and options.');
            }
            var resolved = ts.resolveModuleName(moduleId, this.file.fileName, this.tsOpts, this.host);
            if (resolved && resolved.resolvedModule) {
                var resolvedModule = resolved.resolvedModule.resolvedFileName.replace(/(\.d)?\.ts$/, '');
                var requestedModule = moduleId.replace(/\.js$/, '');
                // If the imported module resolves to foo/index, but the specified module was foo, then we
                // append the /index.
                if (resolvedModule.substr(resolvedModule.length - 6) === '/index' &&
                    requestedModule.substr(requestedModule.length - 6) !== '/index') {
                    moduleId += '/index';
                }
            }
        }
        return moduleId;
    };
    /**
     * Handles emit of an "import ..." statement.
     * We need to do a bit of rewriting so that imported types show up under the
     * correct name in JSDoc.
     * @return true if the decl was handled, false to allow default processing.
     */
    Annotator.prototype.emitImportDeclaration = function (decl) {
        this.writeRange(decl.getFullStart(), decl.getStart());
        this.emit('import');
        var importPath = this.resolveModuleSpecifier(decl.moduleSpecifier);
        var importClause = decl.importClause;
        if (!importClause) {
            // import './foo';
            this.emit("'" + importPath + "';");
            return true;
        }
        else if (importClause.name ||
            (importClause.namedBindings &&
                importClause.namedBindings.kind === ts.SyntaxKind.NamedImports)) {
            this.visit(importClause);
            this.emit(" from '" + importPath + "';");
            // importClause.name implies
            //   import a from ...;
            // namedBindings being NamedImports implies
            //   import {a as b} from ...;
            //
            // Both of these forms create a local name "a", which after TypeScript CommonJS compilation
            // will become some renamed variable like "module_1.default" or "module_1.a" (for default vs
            // named bindings, respectively).
            // tsickle references types in JSDoc. Because the module prefixes are not predictable, and
            // because TypeScript might remove imports entirely if they are only for types, the code below
            // inserts an artificial `const prefix = goog.require` call for the module, and then registers
            // all symbols from this import to be prefixed.
            if (!this.options.untyped) {
                var symbols = [];
                var typeChecker_2 = this.program.getTypeChecker();
                if (importClause.name) {
                    // import a from ...;
                    symbols = [typeChecker_2.getSymbolAtLocation(importClause.name)];
                }
                else {
                    // import {a as b} from ...;
                    if (!importClause.namedBindings ||
                        importClause.namedBindings.kind !== ts.SyntaxKind.NamedImports) {
                        throw new Error('unreached'); // Guaranteed by if check above.
                    }
                    symbols =
                        importClause.namedBindings.elements.map(function (e) { return typeChecker_2.getSymbolAtLocation(e.name); });
                }
                this.forwardDeclare(decl.moduleSpecifier, symbols, !!importClause.name);
            }
            return true;
        }
        else if (importClause.namedBindings &&
            importClause.namedBindings.kind === ts.SyntaxKind.NamespaceImport) {
            // import * as foo from ...;
            this.visit(importClause);
            this.emit(" from '" + importPath + "';");
            return true;
        }
        else {
            this.errorUnimplementedKind(decl, 'unexpected kind of import');
            return false; // Use default processing.
        }
    };
    /**
     * Emits a `goog.forwardDeclare` alias for each symbol from the given list.
     * @param specifier the import specifier, i.e. module path ("from '...'").
     */
    Annotator.prototype.forwardDeclare = function (specifier, symbols, isDefaultImport) {
        if (isDefaultImport === void 0) { isDefaultImport = false; }
        if (this.options.untyped)
            return;
        var importPath = this.resolveModuleSpecifier(specifier);
        var nsImport = es5processor_1.extractGoogNamespaceImport(importPath);
        var forwardDeclarePrefix = "tsickle_forward_declare_" + ++this.forwardDeclareCounter;
        var moduleNamespace = nsImport !== null ? nsImport : this.pathToModuleName(this.file.fileName, importPath);
        var typeChecker = this.program.getTypeChecker();
        var exports = typeChecker.getExportsOfModule(typeChecker.getSymbolAtLocation(specifier));
        // In TypeScript, importing a module for use in a type annotation does not cause a runtime load.
        // In Closure Compiler, goog.require'ing a module causes a runtime load, so emitting requires
        // here would cause a change in load order, which is observable (and can lead to errors).
        // Instead, goog.forwardDeclare types, which allows using them in type annotations without
        // causing a load. See below for the exception to the rule.
        /* this.emit(`\nconst ${forwardDeclarePrefix} = goog.forwardDeclare('${moduleNamespace}');`); */
        var hasValues = exports.some(function (e) { return (e.flags & ts.SymbolFlags.Value) !== 0; });
        if (!hasValues) {
        }
        for (var _i = 0, symbols_1 = symbols; _i < symbols_1.length; _i++) {
            var sym = symbols_1[_i];
            if (sym.flags & ts.SymbolFlags.Alias)
                sym = typeChecker.getAliasedSymbol(sym);
            // goog: imports don't actually use the .default property that TS thinks they have.
            var qualifiedName = nsImport && isDefaultImport ? forwardDeclarePrefix :
                forwardDeclarePrefix + '.' + sym.name;
            this.symbolsToAliasedNames.set(sym, qualifiedName);
        }
    };
    Annotator.prototype.visitClassDeclaration = function (classDecl) {
        var jsDoc = this.getJSDoc(classDecl) || [];
        if (hasModifierFlag(classDecl, ts.ModifierFlags.Abstract)) {
            jsDoc.push({ tagName: 'abstract' });
        }
        if (!this.options.untyped && classDecl.heritageClauses) {
            // If the class has "extends Foo", that is preserved in the ES6 output
            // and we don't need to do anything.  But if it has "implements Foo",
            // that is a TS-specific thing and we need to translate it to the
            // the Closure "@implements {Foo}".
            for (var _i = 0, _a = classDecl.heritageClauses; _i < _a.length; _i++) {
                var heritage = _a[_i];
                if (!heritage.types)
                    continue;
                if (heritage.token === ts.SyntaxKind.ImplementsKeyword) {
                    for (var _b = 0, _c = heritage.types; _b < _c.length; _b++) {
                        var impl = _c[_b];
                        var tagName = 'implements';
                        // We can only @implements an interface, not a class.
                        // But it's fine to translate TS "implements Class" into Closure
                        // "@extends {Class}" because this is just a type hint.
                        var typeChecker = this.program.getTypeChecker();
                        var sym = typeChecker.getSymbolAtLocation(impl.expression);
                        if (sym.flags & ts.SymbolFlags.TypeAlias) {
                            // It's implementing a type alias.  Follow the type alias back
                            // to the original symbol to check whether it's a type or a value.
                            var type = typeChecker.getDeclaredTypeOfSymbol(sym);
                            if (!type.symbol) {
                                // It's not clear when this can happen, but if it does all we
                                // do is fail to emit the @implements, which isn't so harmful.
                                continue;
                            }
                            sym = type.symbol;
                        }
                        if (sym.flags & ts.SymbolFlags.Alias) {
                            sym = typeChecker.getAliasedSymbol(sym);
                        }
                        if (sym.flags & ts.SymbolFlags.Class) {
                            tagName = 'extends';
                        }
                        else if (sym.flags & ts.SymbolFlags.Value) {
                            // If the symbol was already in the value namespace, then it will
                            // not be a type in the Closure output (because Closure collapses
                            // the type and value namespaces).  Just ignore the implements.
                            continue;
                        }
                        // typeToClosure includes nullability modifiers, so getText() directly here.
                        var alias = this.symbolsToAliasedNames.get(sym);
                        jsDoc.push({ tagName: tagName, type: alias || impl.getText() });
                    }
                }
            }
        }
        this.emit('\n');
        if (jsDoc.length > 0)
            this.emit(jsdoc.toString(jsDoc));
        if (classDecl.members.length > 0) {
            // We must visit all members individually, to strip out any
            // /** @export */ annotations that show up in the constructor
            // and to annotate methods.
            this.writeRange(classDecl.getStart(), classDecl.members[0].getFullStart());
            for (var _d = 0, _e = classDecl.members; _d < _e.length; _d++) {
                var member = _e[_d];
                this.visit(member);
            }
        }
        else {
            this.writeRange(classDecl.getStart(), classDecl.getLastToken().getFullStart());
        }
        this.writeNode(classDecl.getLastToken());
        this.emitTypeAnnotationsHelper(classDecl);
        return true;
    };
    Annotator.prototype.emitInterface = function (iface) {
        if (this.options.untyped)
            return;
        // If this symbol is both a type and a value, we cannot emit both into Closure's
        // single namespace.
        var sym = this.program.getTypeChecker().getSymbolAtLocation(iface.name);
        if (sym.flags & ts.SymbolFlags.Value)
            return;
        this.emit("\n/** @record */\n");
        if (hasModifierFlag(iface, ts.ModifierFlags.Export))
            this.emit('export ');
        var name = rewriter_1.getIdentifierText(iface.name);
        this.emit("function " + name + "() {}\n");
        if (iface.typeParameters) {
            this.emit("// TODO: type parameters.\n");
        }
        if (iface.heritageClauses) {
            this.emit("// TODO: derived interfaces.\n");
        }
        var memberNamespace = [name, 'prototype'];
        for (var _i = 0, _a = iface.members; _i < _a.length; _i++) {
            var elem = _a[_i];
            this.visitProperty(memberNamespace, elem);
        }
    };
    // emitTypeAnnotationsHelper produces a
    // _tsickle_typeAnnotationsHelper() where none existed in the
    // original source.  It's necessary in the case where TypeScript
    // syntax specifies there are additional properties on the class,
    // because to declare these in Closure you must declare these in a
    // method somewhere.
    Annotator.prototype.emitTypeAnnotationsHelper = function (classDecl) {
        var _this = this;
        // Gather parameter properties from the constructor, if it exists.
        var ctors = [];
        var paramProps = [];
        var nonStaticProps = [];
        var staticProps = [];
        for (var _i = 0, _a = classDecl.members; _i < _a.length; _i++) {
            var member = _a[_i];
            if (member.kind === ts.SyntaxKind.Constructor) {
                ctors.push(member);
            }
            else if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
                var prop = member;
                var isStatic = hasModifierFlag(prop, ts.ModifierFlags.Static);
                if (isStatic) {
                    staticProps.push(prop);
                }
                else {
                    nonStaticProps.push(prop);
                }
            }
        }
        if (ctors.length > 0) {
            var ctor = ctors[0];
            paramProps = ctor.parameters.filter(function (p) { return hasModifierFlag(p, VISIBILITY_FLAGS); });
        }
        if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0) {
            // There are no members so we don't need to emit any type
            // annotations helper.
            return;
        }
        if (!classDecl.name)
            return;
        var className = rewriter_1.getIdentifierText(classDecl.name);
        this.emit("\n\nfunction " + className + "_tsickle_Closure_declarations() {\n");
        staticProps.forEach(function (p) { return _this.visitProperty([className], p); });
        var memberNamespace = [className, 'prototype'];
        nonStaticProps.forEach(function (p) { return _this.visitProperty(memberNamespace, p); });
        paramProps.forEach(function (p) { return _this.visitProperty(memberNamespace, p); });
        this.emit("}\n");
    };
    Annotator.prototype.propertyName = function (prop) {
        if (!prop.name)
            return null;
        switch (prop.name.kind) {
            case ts.SyntaxKind.Identifier:
                return rewriter_1.getIdentifierText(prop.name);
            case ts.SyntaxKind.StringLiteral:
                // E.g. interface Foo { 'bar': number; }
                // If 'bar' is a name that is not valid in Closure then there's nothing we can do.
                return prop.name.text;
            default:
                return null;
        }
    };
    Annotator.prototype.visitProperty = function (namespace, p) {
        var name = this.propertyName(p);
        if (!name) {
            this.emit("/* TODO: handle strange member:\n" + this.escapeForComment(p.getText()) + "\n*/\n");
            return;
        }
        var tags = this.getJSDoc(p) || [];
        tags.push({ tagName: 'type', type: this.typeToClosure(p) });
        // Avoid printing annotations that can conflict with @type
        // This avoids Closure's error "type annotation incompatible with other annotations"
        this.emit(jsdoc.toString(tags, ['param', 'return']));
        namespace = namespace.concat([name]);
        this.emit(namespace.join('.') + ";\n");
    };
    Annotator.prototype.visitTypeAlias = function (node) {
        if (this.options.untyped)
            return;
        // If the type is also defined as a value, skip emitting it. Closure collapses type & value
        // namespaces, the two emits would conflict if tsickle emitted both.
        var sym = this.program.getTypeChecker().getSymbolAtLocation(node.name);
        if (sym.flags & ts.SymbolFlags.Value)
            return;
        // Write a Closure typedef, which involves an unused "var" declaration.
        // Note: in the case of an export, we cannot emit a literal "var" because
        // TypeScript drops exports that are never assigned to (and Closure
        // requires us to not assign to typedef exports).  Instead, emit the
        // "exports.foo;" line directly in that case.
        this.emit("\n/** @typedef {" + this.typeToClosure(node) + "} */\n");
        if (hasModifierFlag(node, ts.ModifierFlags.Export)) {
            this.emit('exports.');
        }
        else {
            this.emit('var ');
        }
        this.emit(node.name.getText() + ";\n");
    };
    /** Processes an EnumDeclaration or returns false for ordinary processing. */
    Annotator.prototype.maybeProcessEnum = function (node) {
        if (hasModifierFlag(node, ts.ModifierFlags.Const)) {
            // const enums disappear after TS compilation and consequently need no
            // help from tsickle.
            return false;
        }
        // Gather the members of enum, saving the constant value or
        // initializer expression in the case of a non-constant value.
        var members = new Map();
        var i = 0;
        for (var _i = 0, _a = node.members; _i < _a.length; _i++) {
            var member = _a[_i];
            var memberName = member.name.getText();
            if (member.initializer) {
                var enumConstValue = this.program.getTypeChecker().getConstantValue(member);
                if (enumConstValue !== undefined) {
                    members.set(memberName, enumConstValue);
                    i = enumConstValue + 1;
                }
                else {
                    // Non-constant enum value.  Save the initializer expression for
                    // emitting as-is.
                    // Note: if the member's initializer expression refers to another
                    // value within the enum (e.g. something like
                    //   enum Foo {
                    //     Field1,
                    //     Field2 = Field1 + something(),
                    //   }
                    // Then when we emit the initializer we produce invalid code because
                    // on the Closure side it has to be written "Foo.Field1 + something()".
                    // Hopefully this doesn't come up often -- if the enum instead has
                    // something like
                    //     Field2 = Field1 + 3,
                    // then it's still a constant expression and we inline the constant
                    // value in the above branch of this "if" statement.
                    members.set(memberName, member.initializer);
                }
            }
            else {
                members.set(memberName, i);
                i++;
            }
        }
        // Emit the enum declaration, which looks like:
        //   type Foo = number;
        //   let Foo: any = {};
        // We use an "any" here rather than a more specific type because
        // we think TypeScript has already checked types for us, and it's
        // a bit difficult to provide a type that matches all the interfaces
        // expected of an enum (in particular, it is keyable both by
        // string and number).
        // We don't emit a specific Closure type for the enum because it's
        // also difficult to make work: for example, we can't make the name
        // both a typedef and an indexable object if we export it.
        this.emit('\n');
        var name = node.name.getText();
        var isExported = hasModifierFlag(node, ts.ModifierFlags.Export);
        if (isExported)
            this.emit('export ');
        this.emit("type " + name + " = number;\n");
        if (isExported)
            this.emit('export ');
        this.emit("let " + name + ": any = {};\n");
        // Emit foo.BAR = 0; lines.
        for (var _b = 0, _c = util_1.toArray(members.keys()); _b < _c.length; _b++) {
            var member = _c[_b];
            if (!this.options.untyped)
                this.emit("/** @type {number} */\n");
            this.emit(name + "." + member + " = ");
            var value = members.get(member);
            if (typeof value === 'number') {
                this.emit(value.toString());
            }
            else {
                this.visit(value);
            }
            this.emit(';\n');
        }
        // Emit foo[foo.BAR] = 'BAR'; lines.
        for (var _d = 0, _e = util_1.toArray(members.keys()); _d < _e.length; _d++) {
            var member = _e[_d];
            this.emit(name + "[" + name + "." + member + "] = \"" + member + "\";\n");
        }
        return true;
    };
    return Annotator;
}(ClosureRewriter));
/** ExternsWriter generates Closure externs from TypeScript source. */
var ExternsWriter = (function (_super) {
    __extends(ExternsWriter, _super);
    function ExternsWriter() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    /** visit is the main entry point.  It generates externs from a ts.Node. */
    ExternsWriter.prototype.visit = function (node, namespace) {
        if (namespace === void 0) { namespace = []; }
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile:
                var sourceFile = node;
                for (var _i = 0, _a = sourceFile.statements; _i < _a.length; _i++) {
                    var stmt = _a[_i];
                    this.visit(stmt, namespace);
                }
                break;
            case ts.SyntaxKind.ModuleDeclaration:
                var decl = node;
                switch (decl.name.kind) {
                    case ts.SyntaxKind.Identifier:
                        // E.g. "declare namespace foo {"
                        var name_5 = rewriter_1.getIdentifierText(decl.name);
                        if (name_5 === undefined)
                            break;
                        if (this.isFirstDeclaration(decl)) {
                            this.emit('/** @const */\n');
                            this.writeExternsVariable(name_5, namespace, '{}');
                        }
                        if (decl.body)
                            this.visit(decl.body, namespace.concat(name_5));
                        break;
                    case ts.SyntaxKind.StringLiteral:
                        // E.g. "declare module 'foo' {" (note the quotes).
                        // We still want to emit externs for this module, but
                        // Closure doesn't really provide a mechanism for
                        // module-scoped externs.  For now, ignore the enclosing
                        // namespace (because this is declaring a top-level module)
                        // and emit into a fake namespace.
                        // Declare the top-level "tsickle_declare_module".
                        this.emit('/** @const */\n');
                        this.writeExternsVariable('tsickle_declare_module', [], '{}');
                        namespace = ['tsickle_declare_module'];
                        // Declare the inner "tsickle_declare_module.foo".
                        var importName = decl.name.text;
                        this.emit("// Derived from: declare module \"" + importName + "\"\n");
                        // We also don't care about the actual name of the module ("foo"
                        // in the above example), except that we want it to not conflict.
                        importName = importName.replace(/[^A-Za-z]/g, '_');
                        this.emit('/** @const */\n');
                        this.writeExternsVariable(importName, namespace, '{}');
                        // Declare the contents inside the "tsickle_declare_module.foo".
                        if (decl.body)
                            this.visit(decl.body, namespace.concat(importName));
                        break;
                    default:
                        this.errorUnimplementedKind(decl.name, 'externs generation of namespace');
                }
                break;
            case ts.SyntaxKind.ModuleBlock:
                var block = node;
                for (var _b = 0, _c = block.statements; _b < _c.length; _b++) {
                    var stmt = _c[_b];
                    this.visit(stmt, namespace);
                }
                break;
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.InterfaceDeclaration:
                this.writeExternsType(node, namespace);
                break;
            case ts.SyntaxKind.FunctionDeclaration:
                var fnDecl = node;
                var name_6 = fnDecl.name;
                if (!name_6) {
                    this.error(fnDecl, 'anonymous function in externs');
                    break;
                }
                // Gather up all overloads of this function.
                var sym = this.program.getTypeChecker().getSymbolAtLocation(name_6);
                var decls = sym.declarations.filter(function (d) { return d.kind ===
                    ts.SyntaxKind.FunctionDeclaration; });
                // Only emit the first declaration of each overloaded function.
                if (fnDecl !== decls[0])
                    break;
                var params = this.emitFunctionType(decls);
                this.writeExternsFunction(name_6.getText(), params, namespace);
                break;
            case ts.SyntaxKind.VariableStatement:
                for (var _d = 0, _e = node.declarationList.declarations; _d < _e.length; _d++) {
                    var decl_1 = _e[_d];
                    this.writeExternsVariableDecl(decl_1, namespace);
                }
                break;
            case ts.SyntaxKind.EnumDeclaration:
                this.writeExternsEnum(node, namespace);
                break;
            case ts.SyntaxKind.TypeAliasDeclaration:
                this.writeExternsTypeAlias(node, namespace);
                break;
            default:
                this.emit("\n/* TODO: " + ts.SyntaxKind[node.kind] + " in " + namespace.join('.') + " */\n");
                break;
        }
    };
    /**
     * isFirstDeclaration returns true if decl is the first declaration
     * of its symbol.  E.g. imagine
     *   interface Foo { x: number; }
     *   interface Foo { y: number; }
     * we only want to emit the "@record" for Foo on the first one.
     */
    ExternsWriter.prototype.isFirstDeclaration = function (decl) {
        if (!decl.name)
            return true;
        var typeChecker = this.program.getTypeChecker();
        var sym = typeChecker.getSymbolAtLocation(decl.name);
        if (!sym.declarations || sym.declarations.length < 2)
            return true;
        return decl === sym.declarations[0];
    };
    ExternsWriter.prototype.writeExternsType = function (decl, namespace) {
        var name = decl.name;
        if (!name) {
            this.error(decl, 'anonymous type in externs');
            return;
        }
        var typeName = namespace.concat([name.getText()]).join('.');
        if (exports.closureExternsBlacklist.indexOf(typeName) >= 0)
            return;
        if (this.isFirstDeclaration(decl)) {
            var paramNames = [];
            if (decl.kind === ts.SyntaxKind.ClassDeclaration) {
                var ctors = decl.members.filter(function (m) { return m.kind === ts.SyntaxKind.Constructor; });
                if (ctors.length) {
                    var firstCtor = ctors[0];
                    var ctorTags = [{ tagName: 'constructor' }, { tagName: 'struct' }];
                    if (ctors.length > 1) {
                        paramNames = this.emitFunctionType(ctors, ctorTags);
                    }
                    else {
                        paramNames = this.emitFunctionType([firstCtor], ctorTags);
                    }
                }
                else {
                    this.emit('\n/** @constructor @struct */\n');
                }
            }
            else {
                this.emit('\n/** @record @struct */\n');
            }
            this.writeExternsFunction(name.getText(), paramNames, namespace);
        }
        // Process everything except (MethodSignature|MethodDeclaration|Constructor)
        var methods = new Map();
        for (var _i = 0, _a = decl.members; _i < _a.length; _i++) {
            var member = _a[_i];
            switch (member.kind) {
                case ts.SyntaxKind.PropertySignature:
                case ts.SyntaxKind.PropertyDeclaration:
                    var prop = member;
                    if (prop.name.kind === ts.SyntaxKind.Identifier) {
                        this.emitJSDocType(prop);
                        this.emit("\n" + typeName + ".prototype." + prop.name.getText() + ";\n");
                        continue;
                    }
                    // TODO: For now property names other than Identifiers are not handled; e.g.
                    //    interface Foo { "123bar": number }
                    break;
                case ts.SyntaxKind.MethodSignature:
                case ts.SyntaxKind.MethodDeclaration:
                    var method = member;
                    var methodName = method.name.getText();
                    if (methods.has(methodName)) {
                        methods.get(methodName).push(method);
                    }
                    else {
                        methods.set(methodName, [method]);
                    }
                    continue;
                case ts.SyntaxKind.Constructor:
                    continue; // Handled above.
                default:
                    // Members can include things like index signatures, for e.g.
                    //   interface Foo { [key: string]: number; }
                    // For now, just skip it.
                    break;
            }
            // If we get here, the member wasn't handled in the switch statement.
            var memberName = namespace;
            if (member.name) {
                memberName = memberName.concat([member.name.getText()]);
            }
            this.emit("\n/* TODO: " + ts.SyntaxKind[member.kind] + ": " + memberName.join('.') + " */\n");
        }
        // Handle method declarations/signatures separately, since we need to deal with overloads.
        namespace = namespace.concat([name.getText(), 'prototype']);
        for (var _b = 0, _c = Array.from(methods.values()); _b < _c.length; _b++) {
            var methodVariants = _c[_b];
            var firstMethodVariant = methodVariants[0];
            var parameterNames = void 0;
            if (methodVariants.length > 1) {
                parameterNames = this.emitFunctionType(methodVariants);
            }
            else {
                parameterNames = this.emitFunctionType([firstMethodVariant]);
            }
            this.writeExternsFunction(firstMethodVariant.name.getText(), parameterNames, namespace);
        }
    };
    ExternsWriter.prototype.writeExternsVariableDecl = function (decl, namespace) {
        if (decl.name.kind === ts.SyntaxKind.Identifier) {
            var name_7 = rewriter_1.getIdentifierText(decl.name);
            if (exports.closureExternsBlacklist.indexOf(name_7) >= 0)
                return;
            this.emitJSDocType(decl);
            this.emit('\n');
            this.writeExternsVariable(name_7, namespace);
        }
        else {
            this.errorUnimplementedKind(decl.name, 'externs for variable');
        }
    };
    ExternsWriter.prototype.writeExternsVariable = function (name, namespace, value) {
        var qualifiedName = namespace.concat([name]).join('.');
        if (namespace.length === 0)
            this.emit("var ");
        this.emit(qualifiedName);
        if (value)
            this.emit(" = " + value);
        this.emit(';\n');
    };
    ExternsWriter.prototype.writeExternsFunction = function (name, params, namespace) {
        var paramsStr = params.join(', ');
        if (namespace.length > 0) {
            name = namespace.concat([name]).join('.');
            this.emit(name + " = function(" + paramsStr + ") {};\n");
        }
        else {
            this.emit("function " + name + "(" + paramsStr + ") {}\n");
        }
    };
    ExternsWriter.prototype.writeExternsEnum = function (decl, namespace) {
        var name = rewriter_1.getIdentifierText(decl.name);
        this.emit('\n/** @const */\n');
        this.writeExternsVariable(name, namespace, '{}');
        namespace = namespace.concat([name]);
        for (var _i = 0, _a = decl.members; _i < _a.length; _i++) {
            var member = _a[_i];
            var memberName = void 0;
            switch (member.name.kind) {
                case ts.SyntaxKind.Identifier:
                    memberName = rewriter_1.getIdentifierText(member.name);
                    break;
                case ts.SyntaxKind.StringLiteral:
                    var text = member.name.text;
                    if (isValidClosurePropertyName(text))
                        memberName = text;
                    break;
                default:
                    break;
            }
            if (!memberName) {
                this.emit("\n/* TODO: " + ts.SyntaxKind[member.name.kind] + ": " + member.name.getText() + " */\n");
                continue;
            }
            this.emit('/** @const {number} */\n');
            this.writeExternsVariable(memberName, namespace);
        }
    };
    ExternsWriter.prototype.writeExternsTypeAlias = function (decl, namespace) {
        this.emit("\n/** @typedef {" + this.typeToClosure(decl) + "} */\n");
        this.writeExternsVariable(rewriter_1.getIdentifierText(decl.name), namespace);
    };
    return ExternsWriter;
}(ClosureRewriter));
function annotate(program, file, pathToModuleName, options, host, tsOpts) {
    if (options === void 0) { options = {}; }
    typeTranslator.assertTypeChecked(file);
    return new Annotator(program, file, options, pathToModuleName, host, tsOpts).annotate();
}
exports.annotate = annotate;

//# sourceMappingURL=tsickle.js.map