/*
    generator.js
    Generates JavaScript or TypeScript from input code/AST/model
    (c) 2013-2015 musictheory.net, LLC
    MIT license, http://www.opensource.org/licenses/mit-license.php
*/

"use strict";

const _          = require("lodash");
const esprima     = require("../ext/esprima");
const Syntax     = esprima.Syntax;

const Modifier   = require("./modifier");
const Traverser  = require("./traverser");
const Utils      = require("./utils");

const OJModel    = require("./model").OJModel;
const OJError    = require("./errors").OJError;
const OJWarning  = require("./errors").OJWarning;

const Location = require("./model/OJSymbolTyper").Location;

const OJRootVariable            = "$oj_oj";
const OJClassMethodsVariable    = "$oj_s";
const OJInstanceMethodsVariable = "$oj_m";
const OJTemporaryVariablePrefix = "$oj_t_";
const OJSuperVariable           = "$oj_super";

const OJRootWithGlobalPrefix = OJRootVariable + "._g."
const OJRootWithClassPrefix  = OJRootVariable + "._cls.";

const LanguageEcmascript5 = "ecmascript5";
const LanguageTypechecker = "typechecker";
const LanguageNone        = "none";


module.exports = class Generator {


constructor(ojFile, model, forTypechecker, options)
{
    this._file     = ojFile;
    this._model    = model;
    this._modifier = new Modifier(ojFile.contents.split("\n"), options);
    this._options  = options;

    let inlines = { };
    let symbolTyper = model.getSymbolTyper();

    let language = options["output-language"];
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
        _.each(model.enums, ojEnum => {
            let enumNameSymbol = (ojEnum.name && !ojEnum.anonymous) ? symbolTyper.getSymbolForEnumName(ojEnum.name) : null;

            _.each(ojEnum.values, (value, name) => {
                if (enumNameSymbol && forTypechecker) {
                    inlines[name] = enumNameSymbol + "." + name;
                } else {
                    inlines[name] = value;
                }
            });
        });
    }

    // Typechecker forces 'inline-const'
    if (options["inline-const"] || forTypechecker) {
        _.each(model.consts, ojConst => {
            let name  = ojConst.name;
            let value = ojConst.value;

            if (inlines[name] === undefined) {
                inlines[name] = value;
            }
        });
    }

    let additionalInlines = options["additional-inlines"];
    if (additionalInlines) {
        for (let key in additionalInlines) {
            if (additionalInlines.hasOwnProperty(key)) {
                inlines[key] = JSON.stringify(additionalInlines[key]);
            }
        }
    }

    this._inlines = inlines;
    this._squeeze = options["squeeze"] && (language != LanguageTypechecker);
}


generate()
{
    let traverser = new Traverser(this._file.ast);

    let model    = this._model;
    let modifier = this._modifier;
    let language = this._language;
    let options  = this._options;
    let inlines  = this._inlines;
    let scope    = null;

    let methodNodes = [ ];
    let methodNodeClasses = [ ];
    let currentClass;
    let currentMethodNode;

    let methodUsesSelfVar = false;

    let optionWarnDebugger           = options["warn-debugger"];
    let optionWarnEmptyArrayElement  = options["warn-empty-array-element"];
    let optionWarnGlobalNoType       = options["warn-global-no-type"];
    let optionWarnThisInMethods      = options["warn-this-in-methods"];
    let optionWarnUnknownIvars       = options["warn-unknown-ivars"];
    let optionWarnUnknownSelectors   = options["warn-unknown-selectors"];
    let optionWarnUnusedIvars        = options["warn-unused-ivars"];

    let optionStrictFunctions        = options["strict-functions"];
    let optionStrictObjectLiterals   = options["strict-object-literals"];

    let optionSqueeze = this._squeeze;
    let symbolTyper   = model.getSymbolTyper();

    let removeEnums    = options["inline-enum"]  || (language === LanguageTypechecker);
    let removeConsts   = options["inline-const"] || (language === LanguageTypechecker);
    let knownSelectors = optionWarnUnknownSelectors ? model.selectors : null;

    let rewriteFunctionParameters = (language === LanguageTypechecker) && !optionStrictFunctions;

    let unusedIvars = null;

    let warnings = [ ];

    function makeScope(node)
    {
        scope = { node: node, declarations: [ ], count: 0, previous: scope };
    }

    function canDeclareTemporaryVariable()
    {
        return scope && scope.node && (
            scope.node.type === Syntax.FunctionDeclaration ||
            scope.node.type === Syntax.FunctionExpression  ||
            scope.node.type === Syntax.OJMethodDefinition
        );
    }

    function makeTemporaryVariable(needsDeclaration)
    {
        let name = OJTemporaryVariablePrefix + scope.count++;
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

        let selectorType = currentMethodNode.selectorType;
        let selectorName = currentMethodNode.selectorName;

        if (selectorType == "+") {
            return currentClass.getClassMethodWithName(selectorName);
        } else {
            return currentClass.getInstanceMethodWithName(selectorName);
        }
    }

    function generateMethodDeclaration(isClassMethod, selectorName)
    {
        if (language === LanguageEcmascript5) {
            let where = isClassMethod ? OJClassMethodsVariable : OJInstanceMethodsVariable;
            return where + "." + symbolTyper.getSymbolForSelectorName(selectorName);
        }
    }

    function generateThisIvar(className, ivarName, useSelf)
    {
        return (useSelf ? "self" : "this") + "." + symbolTyper.getSymbolForClassNameAndIvarName(className, ivarName);
    }

    function generateIvarAssignments(ojClass)
    {
        let booleanIvars = [ ];
        let numericIvars = [ ];
        let objectIvars  = [ ];

        let ivars = ojClass.getAllIvars();

        for (let i = 0, length = ivars.length; i < length; i++) {
            let ivar = ivars[i];

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

        let result = "";

        if (objectIvars.length) {
            for (let i = 0, length = objectIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, objectIvars[i]) + "="
            }

            result += "null;"
        }

        if (numericIvars.length) {
            for (let i = 0, length = numericIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, numericIvars[i]) + "="
            }

            result += "0;"
        }

        if (booleanIvars.length) {
            for (let i = 0, length = booleanIvars.length; i < length; i++) {
                result += "this." + symbolTyper.getSymbolForClassNameAndIvarName(ojClass.name, booleanIvars[i]) + "="
            }

            result += "false;"
        }

        return result;
    }

    function isIdentifierTransformable(node)
    {
        let parent = node.oj_parent;

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
        let name = node.name;

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
        let receiver     = node.receiver.value;
        let methodName   = symbolTyper.getSymbolForSelectorName(node.selectorName);
        let hasArguments = false;

        let firstSelector, lastSelector;

        if (knownSelectors && !knownSelectors[node.selectorName]) {
            warnings.push(Utils.makeError(OJWarning.UnknownSelector, "Use of unknown selector '" + node.selectorName + "'", node));
        }

        for (let i = 0, length = node.messageSelectors.length; i < length; i++) {
            let messageSelector = node.messageSelectors[i];

            if (messageSelector.arguments || messageSelector.argument) {
                hasArguments = true;
            }
        }

        function replaceMessageSelectors()
        {
            for (let i = 0, length = node.messageSelectors.length; i < length; i++) {
                let messageSelector = node.messageSelectors[i];

                if (!firstSelector) {
                    firstSelector = messageSelector;
                }

                if (messageSelector.arguments) {
                    let lastArgument = messageSelector.arguments[messageSelector.arguments.length - 1];

                    modifier.from(messageSelector).to(messageSelector.arguments[0]).replace("[");
                    modifier.after(lastArgument).insert("]");

                    lastSelector = lastArgument;

                } else if (messageSelector.argument) {
                    modifier.from(messageSelector).to(messageSelector.argument).remove();
                    lastSelector = messageSelector.argument;

                    if (i < (length - 1)) {
                        let nextSelector = node.messageSelectors[i+1];
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
        if (receiver.type == Syntax.Identifier && currentMethodNode) {
            let usesSelf   = methodUsesSelfVar || (language === LanguageTypechecker);
            let selfOrThis = usesSelf ? "self" : "this";
            let useProto   = (currentMethodNode.selectorType != "+");

            if (receiver.name == "super") {
                if (language === LanguageEcmascript5) {
                    let classSymbol = symbolTyper.getSymbolForClassName(currentClass.name );
                    doCommonReplacement(classSymbol + "." + OJSuperVariable + "." + (useProto ? "prototype." : "") + methodName + ".call(this" + (hasArguments ? "," : ""), ")");

                } else if (language === LanguageTypechecker) {
                    let method = getCurrentMethodInModel();
                    let cast = "";

                    if (method.returnType == "instancetype") {
                        cast = "<" + symbolTyper.toTypecheckerType(currentClass.name) + ">";
                    }

                    doCommonReplacement(cast + selfOrThis + ".$oj_super()." + methodName + "(", ")");
                }
                return;

            } else if (methodName == "class" && (language !== LanguageTypechecker)) {
                if (model.classes[receiver.name]) {
                    doCommonReplacement(getClassAsRuntimeVariable(receiver.name));
                } else if (receiver.name == "self") {
                    doCommonReplacement(selfOrThis + ".constructor");
                } else {
                    doCommonReplacement("(" + receiver.name + " && " + receiver.name + ".constructor)");
                }
                return;

            } else if (model.classes[receiver.name]) {
                let classVariable = getClassAsRuntimeVariable(receiver.name);

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
                let ivar = generateThisIvar(currentClass.name, receiver.name, usesSelf);

                if (language === LanguageTypechecker) {
                    doCommonReplacement("(" + ivar + "." + methodName + "(", "))");
                } else {
                    doCommonReplacement("(" + ivar + " && " + ivar + "." + methodName + "(", "))");
                }

                return;

            } else {
                if (language === LanguageTypechecker) {
                    doCommonReplacement("(" + receiver.name + "." + methodName + "(", "))");
                } else {
                    doCommonReplacement("(" + receiver.name + " && " + receiver.name + "." + methodName + "(", "))");
                }

                return;
            }

        } else if (canDeclareTemporaryVariable()) {
            replaceMessageSelectors();

            if (language === LanguageTypechecker) {
                modifier.from(node).to(receiver).replace("(");

                if (receiver.type == Syntax.Identifier && model.classes[receiver.name]) {
                    modifier.select(receiver).replace(getClassAsRuntimeVariable(receiver.name));
                }

                modifier.from(receiver).to(firstSelector).replace("." + methodName + "(");
                modifier.from(lastSelector).to(node).replace("))");

            } else {
                let temporaryVariable = makeTemporaryVariable(true);

                modifier.from(node).to(receiver).replace("((" + temporaryVariable + " = (");

                if (receiver.type == Syntax.Identifier && model.classes[receiver.name]) {
                    modifier.select(receiver).replace(getClassAsRuntimeVariable(receiver.name));
                }

                modifier.from(receiver).to(firstSelector).replace(")) && " + temporaryVariable + "." + methodName + "(");
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

        let selector = "{ " + methodName + ": 1 }";

        modifier.from(receiver).to(firstSelector).replace("," + selector + (hasArguments ? "," : ""));
        modifier.from(lastSelector).to(node).replace(")");
    }

    function handleOJClassImplementation(node)
    {
        let superName     = (node.superClass && node.superClass.name);
        let classSymbol   = symbolTyper.getSymbolForClassName(node.id.name);
        let classSelector = "{" + classSymbol + ":1}";
 
        // Only allow whitelisted children inside of an @implementation
        _.each(node.body.body, child => {
            let type = child.type;
            
            if (type !== Syntax.EmptyStatement        &&
                type !== Syntax.FunctionDeclaration   &&
                type !== Syntax.VariableDeclaration   &&
                type !== Syntax.OJMethodDefinition    &&
                type !== Syntax.OJPropertyDirective   &&
                type !== Syntax.OJDynamicDirective    &&
                type !== Syntax.OJSynthesizeDirective)
            {
                Utils.throwError(OJError.ParseError, 'Unexpected @implementation child.', child);
            }

            if (type === Syntax.VariableDeclaration) {
                _.each(child.declarations, declarator => {
                    if (declarator.init) {
                        if (declarator.init.type !== Syntax.Literal &&
                            declarator.init.type !== Syntax.FunctionExpression)
                        {
                            Utils.throwError(OJError.ParseError, 'Variable declaration must be initialized to a constant.', declarator.init);
                        }
                    }
                });
            }
        });

        makeScope(node);

        let constructorCallSuper = "";
        let superSelector = null;

        if (superName) {
            constructorCallSuper = getClassAsRuntimeVariable(superName) + ".call(this);";
            superSelector        = "{" + symbolTyper.getSymbolForClassName(superName) + ":1}";
        }

        let constructorSetIvars = generateIvarAssignments(currentClass);

        let startText;
        let endText;

        if (language === LanguageEcmascript5) {
            if (node.category) {
                let categorySelector = "{" + symbolTyper.getSymbolForClassName(node.category) + ":1}";

                startText = OJRootVariable + "._registerCategory(" +
                    classSelector + ", ";

            } else {
                startText = OJRootVariable + "._registerClass(" +
                    classSelector + ", " +
                    (superSelector || "null") + ", ";
            }

            startText = startText +
               
                "function(" + OJClassMethodsVariable + ", " + OJInstanceMethodsVariable + ") { " +
                "function " + classSymbol + "() { " +
                constructorCallSuper +
                constructorSetIvars  +
                "this.constructor = " + classSymbol + ";" +
                "this.$oj_id = ++" + OJRootVariable + "._id;" +
                "}";

            endText = "return " + classSymbol + ";});";
        
        } else if (language === LanguageTypechecker) {
            startText = "var $oj_unused = (function(" + OJClassMethodsVariable + " : any, " + OJInstanceMethodsVariable + " : any) { ";
            endText = "});";
        }

        if (!node.ivarDeclarations && !node.body.body.length) {
            modifier.select(node).replace(startText + endText);

        } else {
            modifier.from(node).to(node.ivarDeclarations || node.body).replace(startText);
            modifier.from(node.body).to(node).replace(endText);
        }
    }

    function handleMethodDefinition(node)
    {
        let methodName = symbolTyper.getSymbolForSelectorName(node.selectorName);
        let isClassMethod = node.selectorType == "+";
        let where = isClassMethod ? OJClassMethodsVariable : OJInstanceMethodsVariable;
        let args = [ ];

        makeScope(node);

        if (Utils.isReservedSelectorName(node.selectorName)) {
            Utils.throwError(OJError.ReservedMethodName, "The method name \"" + node.selectorName + "\" is reserved by the runtime and may not be overridden.", node);
        }

        if (language === LanguageTypechecker) {
            args.push("self" + " : " + symbolTyper.getSymbolForClassName(currentClass.name, isClassMethod) );
        }

        for (let i = 0, length = node.methodSelectors.length; i < length; i++) {
            let variableName = node.methodSelectors[i].variableName;
            let methodType   = node.methodSelectors[i].methodType;

            if (variableName) {
                checkRestrictedUsage(variableName);

                let name = variableName.name;

                if (language === LanguageEcmascript5) {
                    args.push(name);
                } else if (language === LanguageTypechecker) {
                    let outputType = symbolTyper.toTypecheckerType(methodType && methodType.value, Location.ImplementationParameter);
                    args.push(name + (methodType ? (" : " + outputType) : ""));
                }
            }
        }

        let definition = where + "." + methodName + " = function(" + args.join(", ") + ") ";

        if (language === LanguageTypechecker) {
            let returnType = getCurrentMethodInModel().returnType;
            returnType = symbolTyper.toTypecheckerType(returnType, Location.ImplementationReturn, currentClass);
            definition += ": " + returnType;
        }

        modifier.from(node).to(node.body).replace(definition);
        modifier.from(node.body).to(node).remove();
    }

    function handleLiteral(node)
    {
        let replacement;

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
        let name = node.name;

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
        let name = node.name;

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

        let ojGlobal = model.globals[name];
        let replacement;

        if (ojGlobal) {
            replacement = OJRootWithGlobalPrefix + (optionSqueeze ? symbolTyper.getSymbolForIdentifierName(name) : name);

            modifier.select(node).replace(replacement);
            return;

        } else if (currentMethodNode && currentClass) {
            if (currentClass.isIvar(name) || name == "self") {
                let usesSelf = currentMethodNode && (methodUsesSelfVar || (language === LanguageTypechecker));

                if (name == "self") {
                    replacement = usesSelf ? "self" : "this";
                } else {
                    replacement = generateThisIvar(currentClass.name, name, usesSelf);

                    // remove ivar from unusedIvars
                    if (optionWarnUnusedIvars) {
                        if (unusedIvars && unusedIvars.indexOf(name) >= 0) {
                            unusedIvars = _.without(unusedIvars, name);
                        }
                    }
                }

                modifier.select(node).replace(replacement);
                return;

            } else {
                if (name[0] == "_" && optionWarnUnknownIvars && (name.length > 1)) {
                    warnings.push(Utils.makeError(OJWarning.UndeclaredInstanceVariable, "Use of undeclared instance variable " + node.name, node));
                }
            } 
        }

        if (inlines) {
            let result = inlines[name];
            if (result !== undefined) {
                if (inlines.hasOwnProperty(name)) {
                    modifier.select(node).replace("" + result);
                    return;
                }
            }
        }

        if (optionSqueeze) {
            let result = symbolTyper.getSymbolForIdentifierName(name);
            if (result !== undefined) {
                modifier.select(node).replace("" + result);
                return;
            }
        }
    }

    function handleVariableDeclaration(node, parent)
    {
        for (let declaration of node.declarations) {
            checkRestrictedUsage(declaration.id);
        }
    }

    function handleOJPropertyDirective(node)
    {
        let name = node.id.name;

        let makeGetter = currentClass.shouldGenerateGetterImplementationForPropertyName(name);
        let makeSetter = currentClass.shouldGenerateSetterImplementationForPropertyName(name);
        let property   = currentClass.getPropertyWithName(name);

        let result = "";
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
        let name = symbolTyper.getSymbolForSelectorName(node.name);

        if (knownSelectors && !knownSelectors[node.name]) {
            warnings.push(Utils.makeError(OJWarning.UnknownSelector, "Use of unknown selector '" + node.selectorName + "'", node));
        }

        modifier.select(node).replace("{ " + name + ": 1 }");
    }

    function handleOJEnumDeclaration(node)
    {
        let length = node.declarations ? node.declarations.length : 0;
        let last   = node;

        if (length) {
            let firstDeclaration = node.declarations[0];
            let lastDeclaration  = node.declarations[length - 1];

            for (let i = 0; i < length; i++) {
                let declaration = node.declarations[i];

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
        let length = node.declarations ? node.declarations.length : 0;
        let values = [ ];

        if (length) {
            let firstDeclaration = node.declarations[0];
            modifier.from(node).to(firstDeclaration.id).replace("var ");

        } else {
            modifier.select(node).remove();
        }
    }

    function handleOJCastExpression(node)
    {
        let before = "(";

        if (language == LanguageTypechecker) {
            before = "<" + symbolTyper.toTypecheckerType(node.id.name) + ">(";
        }

        modifier.from(node).to(node.argument).replace(before);
        modifier.from(node.argument).to(node).replace(")");
    }

    function handleOJAnyExpression(node)
    {
        let before = (language == LanguageTypechecker) ? "<any>(" : "(";

        modifier.from(node).to(node.argument).replace(before);
        modifier.from(node.argument).to(node).replace(")");
    }

    function handleOJTypeAnnotation(node, parent)
    {
        if (language === LanguageTypechecker) {
            let inValue  = node.value;
            let outValue = symbolTyper.toTypecheckerType(inValue);

            if (inValue != outValue) {
                modifier.select(node).replace(": " + outValue);
            }

        } else {
            modifier.select(node).remove();
        }
    }

    function handleOJEachStatement(node)
    {
        let i      = makeTemporaryVariable(false);
        let length = makeTemporaryVariable(false);

        let object, array;
        let initLeft = "var ";
        let initRight = "";
        let expr = false;

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

        let test      = i + " < " + length;
        let increment = i + "++";

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
        let declaration = node.declaration;
        let declarators = node.declarators;

        if (optionWarnGlobalNoType) {
            let allTyped;

            if (declaration) {
                allTyped = !!declaration.annotation && _.every(declaration.params, param => !!param.annotation);

            } else if (declarators) {
                allTyped = _.every(declarators, declarator => !!declarator.id.annotation);
            }

            if (!allTyped) {
                warnings.push(Utils.makeError(OJWarning.MissingTypeAnnotation, "Missing type annotation on @global", node));
            }
        }

        if (language !== LanguageTypechecker) {
            if (declaration) {
                let name = symbolTyper.getSymbolForIdentifierName(declaration.id.name);

                modifier.from(node).to(declaration).replace(OJRootWithGlobalPrefix + name + "=");
                modifier.select(declaration.id).remove();
                declaration.id.oj_skip = true;

            } else if (declarators) {
                modifier.from(node).to(declarators[0]).remove();

                _.each(declarators, declarator => {
                    let name = symbolTyper.getSymbolForIdentifierName(declarator.id.name);

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

                let index = 0;
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

        _.each(node.params, param => {
            checkRestrictedUsage(param);
        });

        // Unlike JavaScript, TypeScript assumes every parameter to a function is required.
        // This results in many false positives for our JavaScript code
        //
        // Disable this by rewriting the parameter list
        //
        if (rewriteFunctionParameters) {
            let result = "function " + (node.id ? node.id.name : "") + "(";

            for (let i = 0, length = node.params.length; i < length; i++) {
                let param = node.params[i];

                let type = "any";
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

    function finishScope(scope, needsSelf)
    {
        let node = scope.node;
        let varParts = [ ];
        let toInsert = "";

        if (needsSelf && (language !== LanguageTypechecker)) varParts.push("self = this");

        _.each(scope.declarations, declaration => {
            varParts.push(declaration);
        });

        if (varParts.length) {
            toInsert += "var " + varParts.join(",") + ";";
        }

        if (toInsert.length && scope.node.body.body.length) {
            modifier.before(scope.node.body.body[0]).insert(toInsert);
        }
    }

    function checkThis(thisNode, path)
    {
        let inFunction = false;
        let inMethod   = true;

        for (let i = path.length - 1; i >= 0; i--) {
            let node = path[i];

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
        let type = node.type;

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

        } else if (type === Syntax.OJBridgedDeclaration) {
            modifier.from(node).to(node.declaration).remove();

        } else if (type === Syntax.OJClassImplementation) {
            currentClass = model.classes[node.id.name];

            if (optionWarnUnusedIvars) {
                unusedIvars = currentClass.getAllIvarNamesWithoutProperties();
            }

            handleOJClassImplementation(node);

        } else if (type === Syntax.OJMethodDefinition) {
            currentMethodNode = node;
            methodUsesSelfVar = false;

            handleMethodDefinition(node);

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
            if (optionWarnThisInMethods) {
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

        // Additional warnings
        } else if (type === Syntax.ArrayExpression) {
            if (optionWarnEmptyArrayElement) {
                _.each(node.elements, element => {
                    if (element === null) {
                        warnings.push(Utils.makeError(OJWarning.UseOfEmptyArrayElement, "Use of empty array element", node));
                    }
                });
            }

        } else if (type === Syntax.DebuggerStatement) {
            if (optionWarnDebugger) {
                warnings.push(Utils.makeError(OJWarning.UseOfDebugger, "Use of debugger statement", node));
            }
        }

    }, function(node, parent) {
        let type = node.type;

        if (type === Syntax.OJClassImplementation) {
            currentClass = null;

            if (optionWarnUnusedIvars && unusedIvars && unusedIvars.length) {
                _.each(unusedIvars, function(unusedIvar) {
                    warnings.push(Utils.makeError(OJWarning.UnusedInstanceVariable, "Unused instance variable " + unusedIvar, node));
                });

                unusedIvars = null;
            }

        } else if (type === Syntax.OJMethodDefinition) {
            finishScope(scope, methodUsesSelfVar);
            currentMethodNode = null;

        } else if (type === Syntax.FunctionDeclaration || type === Syntax.FunctionExpression) {
            finishScope(scope);
        }

        if (scope.node === node) {
            scope = scope.previous;
        }
    });

    let path = this._file.path;

    _.each(warnings, warning => {
        Utils.addFilePathToError(path, warning);
    });

    return {
        lines: this._modifier.finish(),
        warnings: warnings
    };
}

}
