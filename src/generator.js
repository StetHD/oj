/*
    generator.js
    (c) 2013-2015 musictheory.net, LLC
    MIT license, http://www.opensource.org/licenses/mit-license.php
*/

"use strict";

var _          = require("lodash");
var esprima    = require("./esprima");
var Syntax     = esprima.Syntax;

var Modifier   = require("./modifier");
var Traverser  = require("./traverser");
var Utils      = require("./utils");

var OJModel    = require("./model").OJModel;
var OJError    = require("./errors").OJError;
var OJWarning  = require("./errors").OJWarning;

var Location = require("./model/OJSymbolTyper").Location;

var OJRootVariable            = "$oj_oj";
var OJClassMethodsVariable    = "$oj_s";
var OJInstanceMethodsVariable = "$oj_m";
var OJTemporaryVariablePrefix = "$oj_t_";
var OJTemporaryReturnVariable = "$oj_r";
var OJSuperVariable           = "$oj_super";

var OJRootWithGlobalPrefix = OJRootVariable + "._g."
var OJRootWithClassPrefix  = OJRootVariable + "._cls.";


var LanguageEcmascript5 = "ecmascript5";
var LanguageTypechecker = "typechecker";
var LanguageNone        = "none";


function Generator(ast, model, modifier, forTypechecker, options)
{
    this._ast      = ast;
    this._model    = model;
    this._modifier = modifier;
    this._options  = options;
    this._warnings = [ ];

    var inlines = { };
    var symbolTyper = model.getSymbolTyper();

    var language = options["output-language"];
    if (language && language.match(/typechecker/)) {
        this._language = LanguageTypechecker;
    } else if (language && language.match(/none/)) {
        this._language = LanguageNone;
    } else {
        this._language = LanguageEcmascript5;
    }

    if (forTypechecker || (this._language == LanguageTypechecker)) {
        this._language = LanguageTypechecker;
        forTypechecker = true;

        this._strictFunctions = options["strict-functions"];
    }

    // Typechecker inlines anonymous enums
    if (options["inline-enum"] || forTypechecker) {
        _.each(model.enums, function(e) {
            var enumName = e.name;

            _.each(e.values, function(value, name) {
                if (enumName && forTypechecker) {
                    inlines[name] = symbolTyper.getSymbolForEnumName(enumName) + "." + name;
                } else {
                    inlines[name] = value;
                }
            });
        });
    }

    // Typechecker forces 'inline-const'
    if (options["inline-const"] || forTypechecker) {
        _.each(model.consts, function(value, name) {
            if (inlines[name] === undefined) {
                inlines[name] = value;
            }
        });
    }

    var additionalInlines = options["additional-inlines"];
    if (additionalInlines) {
        for (var key in additionalInlines) {
            if (additionalInlines.hasOwnProperty(key)) {
                inlines[key] = JSON.stringify(additionalInlines[key]);
            }
        }
    }

    this._inlines = inlines;
    this._squeeze = options["squeeze"] && (language != LanguageTypechecker);
}

Generator.prototype.generate = function()
{
    var traverser = new Traverser(this._ast);

    var model    = this._model;
    var modifier = this._modifier;
    var language = this._language;
    var options  = this._options;
    var inlines  = this._inlines;
    var scope    = null;

    var methodNodes = [ ];
    var methodNodeClasses = [ ];
    var currentClass;
    var currentMethodNode;

    var methodUsesSelfVar        = false;
    var methodUsesTemporaryVar   = false;
    var methodUsesLoneExpression = false;

    var optionWarnOnThisInMethods    = options["warn-this-in-methods"];
    var optionWarnOnUnknownSelectors = options["warn-unknown-selectors"];
    var optionWarnOnUnusedIvars      = options["warn-unused-ivars"];
    var optionWarnOnUnknownIvars     = options["warn-unknown-ivars"];
    var optionWarnOnGlobalNoType     = options["warn-global-no-type"];
    var optionStrictFunctions        = options["strict-functions"];
    var optionStrictObjectLiterals   = options["strict-object-literals"];

    var optionSqueeze = this._squeeze;
    var symbolTyper   = model.getSymbolTyper();

    var removeEnums    = options["inline-enum"]  || (language === LanguageTypechecker);
    var removeConsts   = options["inline-const"] || (language === LanguageTypechecker);
    var knownSelectors = optionWarnOnUnknownSelectors ? model.selectors : null;

    var rewriteFunctionParameters = (language === LanguageTypechecker) && !optionStrictFunctions;

    var unusedIvars = null;

    var warnings = this._warnings;

    function makeScope(node)
    {
        scope = { node: node, declarations: [ ], count: 0, previous: scope };
    }

    function makeTemporaryVariable(needsDeclaration)
    {
        var name = OJTemporaryVariablePrefix + scope.count++;
        if (needsDeclaration) scope.declarations.push(name);
        return name;
    }

    function getClassAsRuntimeVariable(className)
    {
        if (language === LanguageEcmascript5) {
            return OJRootWithClassPrefix + symbolTyper.getSymbolForClassName(className);
        }

        return symbolTyper.getSymbolForClassName(className);
    }

    function getCurrentMethodInModel() {
        if (!currentClass || !currentMethodNode) return null;

        var selectorType = currentMethodNode.selectorType;
        var selectorName = currentMethodNode.selectorName;

        if (selectorType == "+") {
            return currentClass.getClassMethodWithName(selectorName);
        } else {
            return currentClass.getInstanceMethodWithName(selectorName);
        }
    }

    function generateMethodDeclaration(isClassMethod, selectorName)
    {
        if (language === LanguageEcmascript5) {
            var where = isClassMethod ? OJClassMethodsVariable : OJInstanceMethodsVariable;

            if (Utils.isJScriptReservedWord(selectorName)) {
                // For IE8
                return where + "[\"" + symbolTyper.getSymbolForSelectorName(selectorName) + "\"]";
            } else {
                return where + "." + symbolTyper.getSymbolForSelectorName(selectorName);
            }
        }
    }

    function generateThisIvar(className, ivarName, useSelf)
    {
        return (useSelf ? "self" : "this") + "." + symbolTyper.getSymbolForClassNameAndIvarName(className, ivarName);
    }

    function generateIvarAssignments(ojClass)
    {
        var booleanIvars = [ ];
        var numericIvars = [ ];
        var objectIvars  = [ ];
        var i, length, ivar;

        var ivars = ojClass.getAllIvars();

        for (i = 0, length = ivars.length; i < length; i++) {
            var ivar = ivars[i];

            if (model.isNumericType(ivar.type)) {
                numericIvars.push(ivar.name);
            } else if (model.isBooleanType(ivar.type)) {
                booleanIvars.push(ivar.name);
            } else {
                objectIvars.push(ivar.name);
            }
        }

        numericIvars.sort();
        booleanIvars.sort();
        objectIvars.sort();

        var result = "";

        if (objectIvars.length) {
            for (i = 0, length = objectIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, objectIvars[i]) + "="
            }

            result += "null;"
        }

        if (numericIvars.length) {
            for (i = 0, length = numericIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, numericIvars[i]) + "="
            }

            result += "0;"
        }

        if (booleanIvars.length) {
            for (i = 0, length = booleanIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, booleanIvars[i]) + "="
            }

            result += "false;"
        }

        return result;
    }

    function isIdentifierTransformable(node)
    {
        var parent = node.oj_parent;

        if (parent.type === Syntax.MemberExpression) {
            // identifier.x -> true
            if (parent.object === node) {
                return true;

            // x[identifier] =  computed = true
            // x.identifier  = !computed = false
            } else {
                return parent.computed;
            }

        } else if (parent.type === Syntax.Property) {
            // { x: identifier }
            if (parent.value === node) {
                return true;

            // { [identifier]: x } =  computed = true
            // {  identifier : x } = !computed = false
            } else {
                return parent.computed;
            }
        }

        return true;   
    }

    function checkRestrictedUsage(node)
    {
        var name = node.name;

        if (!isIdentifierTransformable(node)) return;

        if (currentMethodNode && currentClass) {
            if (currentClass && currentClass.isIvar(name)) {
                Utils.throwError(OJError.RestrictedUsage, "Cannot use instance variable \"" + name + "\" here.", node);
            }
        }

        if (inlines[name] || model.globals[name]) {
            Utils.throwError(OJError.RestrictedUsage, "Cannot use compiler-inlined \"" + name + "\" here.", node);
        }
    }

    function handleOJMessageExpression(node)
    {
        var receiver     = node.receiver.value;
        var methodName   = symbolTyper.getSymbolForSelectorName(node.selectorName);
        var reserved     = Utils.isJScriptReservedWord(methodName);
        var hasArguments = false;

        var firstSelector, lastSelector;

        if (knownSelectors && !knownSelectors[node.selectorName]) {
            warnings.push(Utils.makeError(OJWarning.UnknownSelector, "Use of unknown selector '" + node.selectorName + "'", node));
        }

        for (var i = 0, length = node.messageSelectors.length; i < length; i++) {
            var messageSelector = node.messageSelectors[i];

            if (messageSelector.arguments || messageSelector.argument) {
                hasArguments = true;
            }
        }

        function replaceMessageSelectors()
        {
            for (var i = 0, length = node.messageSelectors.length; i < length; i++) {
                var messageSelector = node.messageSelectors[i];

                if (!firstSelector) {
                    firstSelector = messageSelector;
                }

                if (messageSelector.arguments) {
                    var lastArgument = messageSelector.arguments[messageSelector.arguments.length - 1];

                    modifier.from(messageSelector).to(messageSelector.arguments[0]).replace("[");
                    modifier.after(lastArgument).insert("]");

                    lastSelector = lastArgument;

                } else if (messageSelector.argument) {
                    modifier.from(messageSelector).to(messageSelector.argument).remove();
                    lastSelector = messageSelector.argument;

                    if (i < (length - 1)) {
                        var nextSelector = node.messageSelectors[i+1];
                        modifier.from(messageSelector.argument).to(nextSelector).replace(",");
                    }

                } else {
                    modifier.select(messageSelector).remove()
                    lastSelector = messageSelector;
                    messageSelector.oj_skip = true;
                }
            }        
        }

        function doCommonReplacement(start, end) {
            replaceMessageSelectors();

            node.receiver.oj_skip = true;

            modifier.from(node).to(firstSelector).replace(start);
            modifier.from(lastSelector).to(node).replace(end);
        }

        // Optimization cases
        if (receiver.type == Syntax.Identifier && currentMethodNode && !reserved) {
            var usesSelf   = methodUsesSelfVar || (language === LanguageTypechecker);
            var selfOrThis = usesSelf ? "self" : "this";
            var useProto   = (currentMethodNode.selectorType != "+");

            if (receiver.name == "super") {
                if (language === LanguageEcmascript5) {
                    doCommonReplacement(currentClass.name + "." + OJSuperVariable + "." + (useProto ? "prototype." : "") + methodName + ".call(this" + (hasArguments ? "," : ""), ")");

                } else if (language === LanguageTypechecker) {
                    var method = getCurrentMethodInModel();
                    var cast = "";

                    if (method.returnType == "instancetype") {
                        cast = "<" + symbolTyper.toTypecheckerType(currentClass.name) + ">";
                    }

                    doCommonReplacement(cast + selfOrThis + ".$oj_super()." + methodName + "(", ")");
                }
                return;

            } else if (model.classes[receiver.name]) {
                var classVariable = getClassAsRuntimeVariable(receiver.name);

                if (methodName == "alloc") {
                    node.receiver.oj_skip = true;
                    modifier.select(node).replace("new " + classVariable + "()");
                    return;
                }

                doCommonReplacement(classVariable + "." + methodName + "(", ")");
                return;

            } else if (receiver.name == "self") {
                doCommonReplacement(selfOrThis + "." + methodName + "(", ")");
                return;

            } else if (currentClass.isIvar(receiver.name)) {
                var ivar = generateThisIvar(currentClass.name, receiver.name, usesSelf);

                methodUsesLoneExpression = true;

                if (language === LanguageTypechecker) {
                    doCommonReplacement("(" + ivar + "." + methodName + "(", "))");
                } else {
                    doCommonReplacement("(" + ivar + " && " + ivar + "." + methodName + "(", "))");
                }

                return;

            } else {
                methodUsesLoneExpression = true;

                if (language === LanguageTypechecker) {
                    doCommonReplacement("(" + receiver.name + "." + methodName + "(", "))");
                } else {
                    doCommonReplacement("(" + receiver.name + " && " + receiver.name + "." + methodName + "(", "))");
                }

                return;
            }

        } else if (currentMethodNode) {
            methodUsesTemporaryVar   = true;
            methodUsesLoneExpression = true;

            replaceMessageSelectors();

            if (language === LanguageTypechecker) {
                modifier.from(node).to(receiver).replace("(");

                if (receiver.type == Syntax.Identifier && model.classes[receiver.name]) {
                    modifier.select(receiver).replace(getClassAsRuntimeVariable(receiver.name));
                }

                modifier.from(receiver).to(firstSelector).replace("." + methodName + "(");
                modifier.from(lastSelector).to(node).replace("))");

            } else {
                modifier.from(node).to(receiver).replace("((" + OJTemporaryReturnVariable + " = (");

                if (receiver.type == Syntax.Identifier && model.classes[receiver.name]) {
                    modifier.select(receiver).replace(getClassAsRuntimeVariable(receiver.name));
                }

                modifier.from(receiver).to(firstSelector).replace(")) && " + OJTemporaryReturnVariable + "." + methodName + "(");
                modifier.from(lastSelector).to(node).replace("))");
            }

            return;
        }

        // Slow path
        replaceMessageSelectors();

        modifier.from(node).to(receiver).replace(OJRootVariable + ".msgSend(");

        if (receiver.type == Syntax.Identifier && model.classes[receiver.name]) {
            modifier.select(receiver).replace(getClassAsRuntimeVariable(receiver.name));
        }

        var selector;
        if (Utils.isJScriptReservedWord(methodName)) {
            selector = "{ \"" + methodName + "\": " + "1 }";
        } else {
            selector = "{ " + methodName + ": " + "1 }";
        }

        modifier.from(receiver).to(firstSelector).replace("," + selector + (hasArguments ? "," : ""));
        modifier.from(lastSelector).to(node).replace(")");
    }

    function handleOJClassImplementation(node)
    {
        var superClass = (node.superClass && node.superClass.name);

        var superSelector = "{ " + symbolTyper.getSymbolForClassName(superClass)   + ":1 }";
        var clsSelector   = "{ " + symbolTyper.getSymbolForClassName(node.id.name) + ":1 }";

        makeScope(node);

        var constructorCallSuper = "";
        if (superClass) {
            constructorCallSuper = getClassAsRuntimeVariable(superClass) + ".call(this);";
        }


        var constructorSetIvars = generateIvarAssignments(currentClass);

        var startText;
        var endText;

        if (language === LanguageEcmascript5) {
            if (node.category) {
                var categorySelector = "{ " + symbolTyper.getSymbolForClassName(node.category) + ":1 }";

                startText = OJRootVariable + "._registerCategory(" +
                    clsSelector + ", ";

            } else {
                startText = "var " + node.id.name + " = " + OJRootVariable + "._registerClass(" +
                    clsSelector + ", " +
                    (superClass ? superSelector : "null") + ", ";
            }

            startText = startText +
               
                "function(" + OJClassMethodsVariable + ", " + OJInstanceMethodsVariable + ") { " +
                "function " + node.id.name + "() { " +
                constructorCallSuper +
                constructorSetIvars  +
                "this.constructor = " + node.id.name + ";" +
                "this.$oj_id = ++" + OJRootVariable + "._id;" +
                "}";

            endText = "return " + node.id.name + ";});";
        
        } else if (language === LanguageTypechecker) {
            startText = "var $oj_unused = function(" + OJClassMethodsVariable + " : any, " + OJInstanceMethodsVariable + " : any) { ";
            endText = "}";
        } 

        modifier.from(node).to(node.ivarDeclarations || node.body).replace(startText);
        modifier.from(node.body).to(node).replace(endText);
    }

    function handleMethodDefinition(node)
    {
        var methodName = symbolTyper.getSymbolForSelectorName(node.selectorName);
        var isClassMethod = node.selectorType == "+";
        var where = isClassMethod ? OJClassMethodsVariable : OJInstanceMethodsVariable;
        var args = [ ];

        makeScope(node);

        if (Utils.isReservedSelectorName(node.selectorName)) {
            Utils.throwError(OJError.ReservedMethodName, "The method name \"" + node.selectorName + "\" is reserved by the runtime and may not be overridden.", node);
        }

        if (language === LanguageTypechecker) {
            args.push("self" + " : " + symbolTyper.getSymbolForClassName(currentClass.name, isClassMethod) );
        }

        for (var i = 0, length = node.methodSelectors.length; i < length; i++) {
            var variableName = node.methodSelectors[i].variableName;
            var methodType   = node.methodSelectors[i].methodType;

            if (variableName) {
                checkRestrictedUsage(variableName);

                let name = variableName.name;

                if (language === LanguageEcmascript5) {
                    args.push(name);
                } else if (language === LanguageTypechecker) {
                    var outputType = symbolTyper.toTypecheckerType(methodType && methodType.value, Location.ImplementationParameter);
                    args.push(name + (methodType ? (" : " + outputType) : ""));
                }
            }
        }

        var definition = where + "." + methodName + " = function(" + args.join(", ") + ") ";

        if (language === LanguageTypechecker) {
            var returnType = getCurrentMethodInModel().returnType;
            returnType = symbolTyper.toTypecheckerType(returnType, Location.ImplementationReturn, currentClass);
            definition += ": " + returnType;
        }

        modifier.from(node).to(node.body).replace(definition);

        if (methodUsesSelfVar || methodUsesTemporaryVar || methodUsesLoneExpression) {
            var toInsert = "";

            var varParts = [ ];

            if (methodUsesSelfVar && (language !== LanguageTypechecker)) varParts.push("self = this");
            if (methodUsesTemporaryVar) {
                if (language === LanguageEcmascript5) {
                    varParts.push(OJTemporaryReturnVariable);
                } else if (language === LanguageTypechecker) {
                    varParts.push(OJTemporaryReturnVariable + " : " + symbolTyper.toTypecheckerType(node.returnType.value));
                }
            }

            if (methodUsesLoneExpression) {
                toInsert += "/* jshint expr: true */";
            }

            if (varParts.length) {
                toInsert += "var " + varParts.join(",") + ";";
            }

            if (toInsert.length && node.body.body.length) {
                modifier.before(node.body.body[0]).insert(toInsert);
            }
        }

        modifier.from(node.body).to(node).remove();
    }

    function handleLiteral(node)
    {
        var replacement;

        if (node.value === null) {
            replacement = "null";
        } else if (node.value === true) {
            replacement = "true";
        } else if (node.value === false) {
            replacement = "false";
        }

        if (replacement) {
            modifier.select(node).replace(replacement);
        }
    }

    function handleOJPredefinedMacro(node)
    {
        var name = node.name;

        if (name === "@CLASS") {
            if (currentClass) {
                modifier.select(node).replace('"' + currentClass.name + '"');
            } else {
                Utils.throwError(OJError.ParseError, 'Cannot use @CLASS outside of a class @implementation');
            }

        } else if (name === "@SEL") {
            if (currentClass && currentMethodNode) {
                modifier.select(node).replace('"' + currentMethodNode.selectorName + '"');
            } else {
                Utils.throwError(OJError.ParseError, 'Cannot use @SEL outside of a method definition');
            }

        } else if (name === "@FUNCTION") {
            if (currentClass && currentMethodNode) {
                modifier.select(node).replace('"' +
                    currentMethodNode.selectorType + "[" + 
                    currentClass.name              + " " +
                    currentMethodNode.selectorName + "]" +
                '"');
            } else {
                Utils.throwError(OJError.ParseError, 'Cannot use @SEL outside of a method definition');
            }

        } else {
            Utils.throwError(OJError.DollarOJIsReserved, 'Unknown identifier: "' + name + '"');
        }
    }

    function handleIdentifier(node)
    {
        var name = node.name;

        if (name[0] === "$") {
            if (name.indexOf("$oj") == 0) {
                if (name[3] == "$" || name[3] == "_") {
                    Utils.throwError(OJError.DollarOJIsReserved, "Identifiers may not start with \"$oj_\" or \"$oj$\"", node);
                }
            }

        } else if (name[0] === "@") {
            handleOJPredefinedMacro(node);
            return;
        }

        if (!isIdentifierTransformable(node)) return;

        var ojGlobal = model.globals[name];
        var replacement;

        if (ojGlobal) {
            replacement = OJRootWithGlobalPrefix + (optionSqueeze ? symbolTyper.getSymbolForIdentifierName(name) : name);

            modifier.select(node).replace(replacement);
            return;

        } else if (currentMethodNode && currentClass) {
            if (currentClass.isIvar(name) || name == "self") {
                var usesSelf = currentMethodNode && (methodUsesSelfVar || (language === LanguageTypechecker));

                if (name == "self") {
                    replacement = usesSelf ? "self" : "this";
                } else {
                    replacement = generateThisIvar(currentClass.name, name, usesSelf);

                    // remove ivar from unusedIvars
                    if (optionWarnOnUnusedIvars) {
                        if (unusedIvars && unusedIvars.indexOf(name) >= 0) {
                            unusedIvars = _.without(unusedIvars, name);
                        }
                    }
                }

                modifier.select(node).replace(replacement);
                return;

            } else {
                if (name[0] == "_" && optionWarnOnUnknownIvars && (name.length > 1)) {
                    warnings.push(Utils.makeError(OJWarning.UndeclaredInstanceVariable, "Use of undeclared instance variable " + node.name, node));
                }
            } 
        }

        if (inlines) {
            var result = inlines[name];
            if (result !== undefined) {
                if (inlines.hasOwnProperty(name)) {
                    modifier.select(node).replace("" + result);
                    return;
                }
            }
        }

        if (optionSqueeze) {
            var result = symbolTyper.getSymbolForIdentifierName(name);
            if (result !== undefined) {
                modifier.select(node).replace("" + result);
                return;
            }
        }
    }

    function handleVariableDeclaration(node, parent)
    {
        _.each(node.declarations, function(declaration) {
            checkRestrictedUsage(declaration.id);
        });
    }

    function handleOJPropertyDirective(node)
    {
        var name = node.id.name;

        var makeGetter = currentClass.shouldGenerateGetterImplementationForPropertyName(name);
        var makeSetter = currentClass.shouldGenerateSetterImplementationForPropertyName(name);
        var property   = currentClass.getPropertyWithName(name);

        var result = "";
        if (makeSetter) {
            if (language === LanguageEcmascript5) {
                result += generateMethodDeclaration(false, property.setter);
                result += " = function(arg) { " + generateThisIvar(currentClass.name, property.ivar, false) + " = arg; } ; ";
            }
        }

        if (makeGetter) {
            if (language === LanguageEcmascript5) {
                result += generateMethodDeclaration(false, property.getter);
                result += " = function() { return " + generateThisIvar(currentClass.name, property.ivar, false) + "; } ; ";
            }
        }

        if (!result) {
            modifier.select(node).remove();
        } else {
            modifier.select(node).replace(result);
        }
    }

    function handleOJSelectorDirective(node)
    {
        var name = symbolTyper.getSymbolForSelectorName(node.name);

        if (knownSelectors && !knownSelectors[node.name]) {
            warnings.push(Utils.makeError(OJWarning.UnknownSelector, "Use of unknown selector '" + node.selectorName + "'", node));
        }

        modifier.select(node).replace("{ " + name + ": 1 }");
    }

    function handleOJEnumDeclaration(node)
    {
        var length = node.declarations ? node.declarations.length : 0;
        var last   = node;

        if (length) {
            var firstDeclaration = node.declarations[0];
            var lastDeclaration  = node.declarations[length - 1];
            var declaration, i;

            for (i = 0; i < length; i++) {
                declaration = node.declarations[i];

                if (!declaration.init) {
                    modifier.after(declaration.id).insert("=" + declaration.enumValue);
                }

                if (last == node) {
                    modifier.before(declaration.id).insert("var ");
                    modifier.from(last).to(declaration.id).remove();

                } else {
                    modifier.after(last).insert("; ");
                    modifier.from(last).to(declaration.id).insert("var ");
                }

                last = declaration;
            }

            modifier.after(lastDeclaration).insert(";");
            modifier.from(lastDeclaration).to(node).replace("");

        } else {
            modifier.select(node).remove();
        }
    }

    function handleOJConstDeclaration(node)
    {
        var length = node.declarations ? node.declarations.length : 0;
        var values = [ ];

        if (length) {
            var firstDeclaration = node.declarations[0];
            modifier.from(node).to(firstDeclaration.id).replace("var ");

        } else {
            modifier.select(node).remove();
        }
    }

    function handleOJCastExpression(node)
    {
        var before = "(";

        if (language == LanguageTypechecker) {
            before = "<" + symbolTyper.toTypecheckerType(node.id.name) + ">(";
        }

        modifier.from(node).to(node.argument).replace(before);
        modifier.from(node.argument).to(node).replace(")");
    }

    function handleOJAnyExpression(node)
    {
        var before = (language == LanguageTypechecker) ? "<any>(" : "(";

        modifier.from(node).to(node.argument).replace(before);
        modifier.from(node.argument).to(node).replace(")");
    }

    function handleOJTypeAnnotation(node, parent)
    {
        if (language === LanguageTypechecker) {
            var inValue  = node.value;
            var outValue = symbolTyper.toTypecheckerType(inValue);

            if (inValue != outValue) {
                modifier.select(node).replace(": " + outValue);
            }

        } else {
            modifier.select(node).remove();
        }
    }

    function handleOJEachStatement(node)
    {
        var i      = makeTemporaryVariable(false);
        var length = makeTemporaryVariable(false);

        var object, array;
        var initLeft = "var ";
        var initRight = "";
        var expr = false;

        // The left side is "var foo", "let foo", etc
        if (node.left.type == Syntax.VariableDeclaration) {
            object = node.left.declarations[0].id.name;
            initLeft  += object + ", ";

        // The left side is just an identifier
        } else if (node.left.type == Syntax.Identifier) {
            if (currentClass && currentClass.isIvar(node.left.name)) {
                Utils.throwError(OJError.RestrictedUsage, "Cannot use ivar \"" + node.left.name + "\" on left-hand side of @each", node);
            }

            object = node.left.name;
        }

        // The right side is a simple identifier
        if (language !== LanguageTypechecker && node.right.type == Syntax.Identifier && currentClass && !currentClass.isIvar(node.right.name)) {
            array = node.right.name;

        // The right side is an expression, we need an additional variable
        } else {
            array = makeTemporaryVariable(false);
            initLeft  += array + " = (";
            initRight = initRight + "), ";
            expr = true;
        }

        initRight += i + " = 0, " + length + " = (" + array + " ? " + array + ".length : 0)";

        var test      = "(" + i + " < " + length + ") && (" + object + " = " + array + "[" + i + "])";
        var increment = i + "++";

        if (language === LanguageTypechecker) {
            increment = increment + ", $oj_$EnsureArray(" + array + ")"
        }

        if (expr) {
            modifier.from(node).to(node.right).replace("for (" + initLeft);
            modifier.from(node.right).to(node.body).replace(initRight + "; " + test + "; " + increment + ") ");
        } else {
            modifier.from(node).to(node.body).replace("for (" + initLeft + initRight + "; " + test + "; " + increment + ") ");
        }
    }

    function handleOJGlobalDeclaration(node)
    {
        var declaration = node.declaration;
        var declarators = node.declarators;
        var name;

        if (optionWarnOnGlobalNoType) {
            var allTyped;

            if (declaration) {
                allTyped = !!declaration.annotation && _.every(declaration.params, function(param) {
                    return !!param.annotation;
                });

            } else if (declarators) {
                allTyped = _.every(declarators, function(declarator) {
                    return !!declarator.id.annotation;
                });
            }

            if (!allTyped) {
                warnings.push(Utils.makeError(OJWarning.MissingTypeAnnotation, "Missing type annotation on @global", node));
            }
        }

        if (language !== LanguageTypechecker) {
            if (declaration) {
                name = symbolTyper.getSymbolForIdentifierName(declaration.id.name);

                modifier.from(node).to(declaration).replace(OJRootWithGlobalPrefix + name + "=");
                modifier.select(declaration.id).remove();
                declaration.id.oj_skip = true;

            } else if (declarators) {
                modifier.from(node).to(declarators[0]).remove();

                _.each(declarators, function(declarator) {
                    name = symbolTyper.getSymbolForIdentifierName(declarator.id.name);

                    modifier.select(declarator.id).replace(OJRootWithGlobalPrefix + name);
                    declarator.id.oj_skip = true;
                })
            }

        } else {
            if (declaration) {
                modifier.from(node).to(declaration.id).replace("(function ");
                modifier.select(declaration.id).remove();
                modifier.after(node).insert(");");

                declaration.id.oj_skip = true;

            } else if (declarators) {
                modifier.from(node).to(declarators[0]).replace("(function() { var ");
                modifier.after(node).insert("});");

                var index = 0;
                _.each(declarators, function(declarator) {
                    modifier.select(declarator.id).replace("a" + index++);
                    declarator.id.oj_skip = true;
                });
            }
        }
    }

    function handleObjectExpression_typeCheckerOnly(node)
    {
        if (language !== LanguageTypechecker) return;
        if (optionStrictObjectLiterals) return;

        if (node.properties.length == 0) {
            modifier.select(node).replace("<any>{}");
        } else {
            modifier.from(node).to(node.properties[0]).replace("<any>{");
        }
    }

    function handleFunctionDeclarationOrExpression(node)
    {
        makeScope(node);

        for (let param of node.params) {
            checkRestrictedUsage(param);
        }

        // Unlike JavaScript, TypeScript assumes every parameter to a function is required.
        // This results in many false positives for our JavaScript code
        //
        // Disable this by rewriting the parameter list
        //
        if (rewriteFunctionParameters) {
            var result = "function " + (node.id ? node.id.name : "") + "(";

            for (var i = 0, length = node.params.length; i < length; i++) {
                var param = node.params[i];

                var type = "any";
                if (param.annotation) {
                    type = symbolTyper.toTypecheckerType(param.annotation.value);
                    param.annotation.oj_skip = true;
                }

                result += param.name + "? : " + type + ", ";
            }

            result += "...$oj_rest)";

            if (node.annotation) {
                result += ": " + symbolTyper.toTypecheckerType(node.annotation.value);
                node.annotation.oj_skip = true;
            }

            modifier.from(node).to(node.body).replace(result);
        }
    }

    function checkThis(thisNode, path)
    {
        var inFunction = false;
        var inMethod   = true;

        for (var i = path.length - 1; i >= 0; i--) {
            var node = path[i];

            if (node.type == Syntax.OJMethodDefinition ||
                node.type == Syntax.OJClassImplementation ||
                node.type == Syntax.OJMessageExpression)
            {
                warnings.push(Utils.makeError(OJWarning.UseOfThisInMethod, "Use of 'this' keyword in oj method definition", thisNode));

            } else if (node.type == Syntax.FunctionDeclaration ||
                       node.type == Syntax.FunctionExpression) {
                break;
            }
        }
    }

    makeScope();

    traverser.traverse(function(node, parent) {
        var type = node.type;

        if (node.oj_skip) return Traverser.SkipNode;

        if (type === Syntax.OJStructDefinition                   || 
            type === Syntax.OJProtocolDefinition                 ||
            type === Syntax.OJClassDirective                     ||
            type === Syntax.OJSqueezeDirective                   ||
            type === Syntax.OJBracketVariableBlock               ||
            type === Syntax.OJSynthesizeDirective                ||
            type === Syntax.OJDynamicDirective                   ||
            type === Syntax.OJTypedefDeclaration                 ||
          ((type === Syntax.OJEnumDeclaration)  && removeEnums)  ||
          ((type === Syntax.OJConstDeclaration) && removeConsts)
        ) {
            modifier.select(node).remove();
            return Traverser.SkipNode;

        } else if (type === Syntax.OJClassImplementation) {
            currentClass = model.classes[node.id.name];

            if (optionWarnOnUnusedIvars) {
                unusedIvars = currentClass.getAllIvarNamesWithoutProperties();
            }

            handleOJClassImplementation(node);

        } else if (type === Syntax.OJMethodDefinition) {
            currentMethodNode        = node;
            methodUsesSelfVar        = false;
            methodUsesTemporaryVar   = false;
            methodUsesLoneExpression = false;

        } else if (type === Syntax.OJMessageExpression) {
            handleOJMessageExpression(node);

        } else if (type === Syntax.OJPropertyDirective) {
            handleOJPropertyDirective(node);
            return Traverser.SkipNode;

        } else if (type === Syntax.OJSelectorDirective) {
            handleOJSelectorDirective(node);

        } else if (type === Syntax.OJEnumDeclaration) {
            handleOJEnumDeclaration(node);

        } else if (type === Syntax.OJConstDeclaration) {
            handleOJConstDeclaration(node);

        } else if (type === Syntax.OJCastExpression) {
            handleOJCastExpression(node);

        } else if (type === Syntax.OJAnyExpression) {
            handleOJAnyExpression(node);

        } else if (type === Syntax.OJTypeAnnotation) {
            handleOJTypeAnnotation(node, parent);

        } else if (type === Syntax.OJEachStatement) {
            handleOJEachStatement(node);

        } else if (type === Syntax.OJGlobalDeclaration) {
            handleOJGlobalDeclaration(node);

        } else if (type === Syntax.OJPredefinedMacro) {
            handleOJPredefinedMacro(node);

        } else if (type === Syntax.Literal) {
            handleLiteral(node);

        } else if (type === Syntax.Identifier) {
            handleIdentifier(node);

        } else if (type === Syntax.VariableDeclaration) {
            handleVariableDeclaration(node);

        } else if (type === Syntax.ThisExpression) {
            if (optionWarnOnThisInMethods) {
                checkThis(node, traverser.getParents());
            }

        } else if (type === Syntax.AssignmentExpression) {
            if (currentMethodNode &&
                node.left &&
                node.left.type == Syntax.Identifier &&
                node.left.name == "self")
            {
                methodUsesSelfVar = true;
            }

        } else if (type === Syntax.ObjectExpression) {
            if (language === LanguageTypechecker) {
                handleObjectExpression_typeCheckerOnly(node);
            }

        } else if (type === Syntax.FunctionDeclaration || type === Syntax.FunctionExpression) {
            handleFunctionDeclarationOrExpression(node);
            methodUsesSelfVar = true;
        }

    }, function(node, parent) {
        var type = node.type;

        if (type === Syntax.OJClassImplementation) {
            currentClass = null;

            if (optionWarnOnUnusedIvars && unusedIvars && unusedIvars.length) {
                _.each(unusedIvars, function(unusedIvar) {
                    warnings.push(Utils.makeError(OJWarning.UnusedInstanceVariable, "Unused instance variable " + unusedIvar, node));
                });

                unusedIvars = null;
            }

        } else if (type === Syntax.OJMethodDefinition) {
            handleMethodDefinition(node);
            currentMethodNode = null;
        }

        if (scope.node === node) {
            scope = scope.previous;
        }
    });
}


Generator.prototype.finish = function()
{
    var result = this._modifier.finish();
    result.warnings = this._warnings;
    return result;
}


module.exports = Generator;
