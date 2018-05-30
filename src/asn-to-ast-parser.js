const {
    logMessage,
    logUncompilableType,
    logUnreferencedType
} = require('./misc/logger'),
{
    extract,
    findBy,
    identity,
    separate,
    separateTransforming
} = require('./misc/util');

module.exports = compile;

// string -> array
function compile(asn) {
    logMessage(`Starting ASN compilation...`);
    const headerRegexp = /(.+)\s+DEFINITIONS.*::=\s*BEGIN\s*([^]*)END/,
    lineComment = /-{2}.*(?!-{2})/g,
    localComment = /-{2}.*-{2}/g,
    availableTypes = builtInTypes(),
    primitiveTypes = availableTypes.filter(type => type.isPrimitive),
    leafTypes = availableTypes.filter(type => type.isLeafType),
    findByType = findBy('type')(identity),
    findAvailableType = findByType(availableTypes),
    internalTypeDeclarationCompiler = findAvailableType('InternalTypeDeclaration'),
    emptyTypeCompiler = findAvailableType('EmptyType'),
    higherLevelSizedTypeCompiler = findAvailableType('HigherLevelSizedType'),
    preDeclaration = '(?=[^\\{\\}\\(\\)\\s]+[\\s]*::=)',
    declarationSeparator = new RegExp('[\\s]+' + preDeclaration),
    asnWithoutComments = asn.replace(localComment, '').replace(lineComment, ''),
    matches = headerRegexp.exec(asnWithoutComments),
    rootTypeName = matches[1],
    asnDefinitions = matches[2],
    firstLevelTypes = asnDefinitions
        .split(declarationSeparator)
        .filter(value => value !== undefined)
        .map(findAvailableType('CompleteTypeDeclaration').compile),
    [ast, unsuccessfulTypes] = separateTransforming(
        ([successful]) => successful,
        extractSecond,
        extractSecond,
        firstLevelTypes);

    if (unsuccessfulTypes.length) {
        unsuccessfulTypes.forEach(logUncompilableType);
        return;
    }

    const [preDeclaredTypes, normallyDeclaredTypes] = separate(type => type.preDeclaredType, ast),
    [, uncompiledPreDeclaredTypes] = separate(preDeclaredCompileTest, preDeclaredTypes)
    if (uncompiledPreDeclaredTypes.length) {
        return;
    }

    const [primitiveLevelTypes, maybeSizedTypes] = separateTransforming(
        completeTypePrimitiveLevelCompileTest,
        (_, sharedArray) => sharedArray.pop(),
        identity,
        normallyDeclaredTypes),
    [sizedTypes, uncompilableTypes] = separate(compileCompleteTypeDeclarationToHigherLevelSizedType, maybeSizedTypes);
    if (uncompilableTypes.length) {
        return;
    }

    resolveTypeReferences(sizedTypes.map(type => type.internalType));

    const [internalTypeListLevelTypes, firstLevelEmptyTypes] = primitivesCompileRoutine(primitiveLevelTypes.map(type => type.internalType)),
    primitiveListLevelTypes = internalsCompileRoutine(internalTypeListLevelTypes),
    [internalPrimitiveListLevelTypes, lastLevelEmptyTypes] = primitivesCompileRoutine(primitiveListLevelTypes.map(type => type.referenceType)),
    emptyTypes = firstLevelEmptyTypes.concat(lastLevelEmptyTypes);
    
    internalsCompileRoutine(internalPrimitiveListLevelTypes);
    ast.reduce(huntSizedReferencedTypes, [])
        .forEach(buildSizeReferencesResolver());

    logMessage(`ASN compilation finished.`);
    return [rootTypeName, ast];

    function buildSizeReferencesResolver () {
        return applySizeForReferecedSizes.bind(null, ['minSize', 'maxSize'], /[a-zA-Z]/);

        function applySizeForReferecedSizes (sizes, charRegexp, type) {
            sizes.filter(isText.bind(null, charRegexp, type))
                .forEach(applyActualSize.bind(null, type));
        }

        function isText (charRegexp, type, size) {
            return type[size] && type[size].search(charRegexp) != -1;
        }

        function isReferencedType (sizePropertyName, type, referencedType) {
            return referencedType.identifier == type[sizePropertyName];
        }

        function applyActualSize (type, size) {
            const { internalType } = ast.find(isReferencedType.bind(null, size, type));
            type[size] = internalType.list[0].value;
        }
    }

    function huntSizedReferencedTypes (acc, type) {
        return (acc.push(...fromInternalType(fromCompleteTypes(type))), acc);
    }

    function fromCompleteTypes (completeType) {
        return completeType.internalType ? completeType.internalType : completeType;
    }

    function fromInternalType (internalType) {
        if (internalType.hasReferencedSize) {
            return [internalType];
        }

        if (internalType.type == 'Set' ||
            internalType.type == 'Sequence' ||
            internalType.type == 'Choice') {
            return internalType.list.reduce(huntSizedReferencedTypes, []);
        } 
        
        if (internalType.referenceType) {
            return huntSizedReferencedTypes([], internalType.referenceType);
        }

        return [];
    }

    function preDeclaredCompileTest (type) {
        return primitiveTypes.some(compilePreDeclaredPrimitiveTypes.bind(null, type));
    }

    function compilePreDeclaredPrimitiveTypes (type, primitiveType) {
        const [successful, internalType] = primitiveType.compile(`${type.preDeclaredType} ${type.declaration}`);
        if (successful) {
            Object.assign(type, { internalType: internalType });
        }
        return successful;
    }

    function primitivesCompileRoutine (primitiveLevelTypes) {
        const [leafLevelTypes, listLevelTypes] = separate(type => findAvailableType(type.type).isLeafType, primitiveLevelTypes),
        referableLeafLevelTypes = leafLevelTypes
            .filter(type => type.type == 'SetOf' || type.type == 'SequenceOf');

        resolveTypeReferences(referableLeafLevelTypes);

        const uncompiledListInternalTypes = listLevelTypes.reduce((arr, type) => (arr.push(...type.list), arr), []),
        [internalTypeListLevelTypes, maybeEmptyTypeEntries] = separate(compileToInternalTypeDeclaration, uncompiledListInternalTypes),
        [emptyTypeRecords, uncompilableListLevelTypes] = separate(compileToEmptyType, maybeEmptyTypeEntries);
        if (uncompilableListLevelTypes.length) {
            for (uncompilableTypes of uncompilableListLevelTypes)
                logUncompilableType(uncompilableTypes.declaration);
            throw new Error(`There is/are ${uncompilableListLevelTypes.length} types not compilable. See log for types' names and details.`);
        }

        return [internalTypeListLevelTypes, emptyTypeRecords];
    }

    function internalsCompileRoutine (internalTypeListLevelTypes) {
        const [primitiveListLevelTypes, notPrimitiveListLevelTypes] = separate(compileToPrimitiveType, internalTypeListLevelTypes),
        [definedListLevelTypes, notDefinedListLevelTypes] = separate(compileToIdentifier, notPrimitiveListLevelTypes),
        [sizedTypeListLevelTypes, uncompilableListLevelTypes] = separate(compileInternalTypeToHigherLevelSizedType, notDefinedListLevelTypes);
        if (uncompilableListLevelTypes.length) {
            throw new Error(`There is/are ${uncompilableListLevelTypes.length} types not compilable. See log for types' names and details.`);
        }

        const referableInternalDefinedListLevelTypes = definedListLevelTypes.concat(sizedTypeListLevelTypes.map(type => type.referenceType));
        resolveTypeReferences(referableInternalDefinedListLevelTypes);

        return primitiveListLevelTypes;
    }

    function resolveTypeReferences (typeArray) {
        const [, maybeTypeWithPrimitiveReference] = separate(findReferenceTypes, typeArray);
        if (maybeTypeWithPrimitiveReference.length) {
            const [, unreferencedTypes] = separate(compileToListTypeWithLeafReferenceType, maybeTypeWithPrimitiveReference);
            if (unreferencedTypes.length) {
                unreferencedTypes.forEach(type => logUnreferencedType(type.referenceType));
                throw new Error(`There is/are ${unreferencedTypes.length} types not referenced or declared. See log for details.`)
            }
        }
    }

    function findReferenceTypes (definedType) {
        const actualReferenceType = ast.find(firstLevelType => firstLevelType.identifier == definedType.referenceType);
        if (actualReferenceType) {
            definedType.referenceType = actualReferenceType;
        }
        return !!actualReferenceType;
    }

    function compileToInternalTypeDeclaration (type) {
        const [successful, actualType] = internalTypeDeclarationCompiler.compile(type.declaration);
        if (successful) {
            Object.assign(type, actualType);
        } else {
            Object.assign(type, { type: 'undefined' });
        }
        return successful;
    }

    function compileToEmptyType (type) {
        const [successful, actualType] = emptyTypeCompiler.compile(type.declaration);
        if (successful) {
            Object.assign(type, actualType);
        } else {
            Object.assign(type, { type: 'undefined' });
        }
        return successful;
    }

    function compileToListTypeWithLeafReferenceType (type) {
        const isLeafType = findAvailableType(type.type).isLeafType;
        if (!isLeafType) {
            return isLeafType;
        }

        return leafTypeFromListTypeCompileTest(type)
    }

    function compileToPrimitiveType (type) {
        const isPrimitiveType = internalTypePrimitiveLevelCompileTest(type);
        if (!isPrimitiveType) {
            Object.assign(type, { referenceType: 'undefined' });
        }
        return isPrimitiveType;
    }

    function compileToIdentifier (type) {
        const isIdentifier = !type.typeDeclaration.trim().includes(' ');
        if (isIdentifier) {
            Object.assign(type, { referenceType: type.typeDeclaration.trim() });
        } else {
            Object.assign(type, { referenceType: 'undefined' });
            // probably a sized type
        }
        return isIdentifier;
    }

    function compileCompleteTypeDeclarationToHigherLevelSizedType (type) {
        return compileToHigherLevelSizedType('declaration', 'internalType', type);
    }

    function compileInternalTypeToHigherLevelSizedType (type) {
        return compileToHigherLevelSizedType('typeDeclaration', 'referenceType', type);
    }

    function compileToHigherLevelSizedType (typeMemberToCompile, typeMemberToSaveCompiled, type) {
        const [successful, referenceType] = higherLevelSizedTypeCompiler.compile(type[typeMemberToCompile]);
        if (successful) {
            Object.assign(type, { [typeMemberToSaveCompiled]: referenceType });
        } else {
            Object.assign(type, { [typeMemberToSaveCompiled]: 'undefined' });
            logUncompilableType(type[typeMemberToCompile]);
        }
        return successful;
    }

    function completeTypePrimitiveLevelCompileTest (abstractType, sharedArray) {
        return typeListCompileTest(primitiveTypes, 'declaration', 'internalType', abstractType, sharedArray);
    }

    function internalTypePrimitiveLevelCompileTest (internalType) {
        return typeListCompileTest(primitiveTypes, 'typeDeclaration', 'referenceType', internalType);
    }

    function leafTypeFromListTypeCompileTest (internalType) {
        return typeListCompileTest(leafTypes, 'referenceType', 'referenceType', internalType);
    }

    function extractSecond (arr) {
        return extract(1, arr);
    }

    function typeListCompileTest (typeList,
        inputTypeDescriptorPropertyToCompile,
        inputTypeDescriptorCompiledProperty,
        inputTypeDescriptor,
        sharedArray /* see separateTransforming function*/) {
        return typeList.some(compileSuccessfullyTest);
    
        function compileSuccessfullyTest (type) {
            const [successful, internalType] = type.compile(inputTypeDescriptor[inputTypeDescriptorPropertyToCompile]);
            if (successful) {
                Object.assign(inputTypeDescriptor, {
                    [inputTypeDescriptorCompiledProperty]: internalType
                });
                (sharedArray && sharedArray.push(inputTypeDescriptor));
                return successful;
            }
        }
    }
}

function builtInTypes() {
    const
    // statement
    blockOpening = '\\{',
    blockClosing = '\\}',
    listDelimiter = ',?',
    spaceDelimiter = '\\s',
    optionalSpaceDelimiter = `${spaceDelimiter}*`,
    mandatorySpaceDelimiter = `${spaceDelimiter}+`,
    // declaration
    mandatoryIdentifier = '([^\\{\\}\\(\\)\\s\\[\\]]+)',
    optionalIdentifier = `${mandatoryIdentifier}?`,
    ASNClass = '(?:UNIVERSAL|APPLICATION|PRIVATE)?',
    optionalDefault = `(OPTIONAL|DEFAULT${mandatorySpaceDelimiter}([^,]*))`,
    tagType = '(?:IMPLICIT|EXPLICIT)?',
    tagClassNumber = `(?:\\[${optionalSpaceDelimiter}${ASNClass}${optionalSpaceDelimiter}\\d+${optionalSpaceDelimiter}\\])?`,
    tag = `${tagClassNumber}${optionalSpaceDelimiter}${tagType}`,
    listHole = '([^\\{\\}]+)',
    typeHole = `([^,\\{\\}]+(?:\\{${listHole}\\})?)`,
    optionalSize = `(?:\\(?SIZE${optionalSpaceDelimiter}\\((\\w+)(?:\\.\\.(\\w+))?\\)\\)?)?`,
    ellipisRegexp = /\.{3}/,
    // operator
    assignment = '::=',
    // helper
    charRegexp = /[a-zA-Z]/,
    syntaxTrees = [{
            type: 'CompleteTypeDeclaration',
            syntaxTree: [
                mandatoryIdentifier,
                optionalSpaceDelimiter,
                `(?:${mandatorySpaceDelimiter}((?:${mandatoryIdentifier}${optionalSpaceDelimiter})+))?`,
                assignment,
                optionalSpaceDelimiter,
                `([^]*)`
            ],
            compile({
                matches
            }) {
                return [true, {
                    type: 'CompleteTypeDeclaration',
                    preDeclaredType: matches[2],
                    identifier: matches[1],
                    declaration: matches[4]
                }];
            }
        },
        {
            type: 'InternalTypeDeclaration',
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                //optionalIdentifier,
                mandatoryIdentifier,
                optionalSpaceDelimiter,
                tag,
                `([^,\\{\\}]*(?:\\{${listHole}\\})?)`,
                listDelimiter
            ],
            holeTree: [`.*${optionalDefault}`],
            compile({
                holeRegexp,
                matches
            }) {
                const holeMatches = holeRegexp.exec(matches[2]);

                holeRegexp.lastIndex = 0;
                return [true, {
                    type: 'InternalTypeDeclaration',
                    identifier: matches[1] || '',
                    declaration: matches.input,
                    typeDeclaration: resolveTypeDeclaration(),
                    isOptional: isOptional(),
                    defaultValue: resolveDefaultValue()
                }];

                function resolveDefaultValue () {
                    return !!holeMatches
                        ? holeMatches[2]
                        : undefined;
                }

                function isOptional () {
                    return !!holeMatches && !!holeMatches[1];
                }

                function resolveTypeDeclaration () {
                    return isOptional()
                        ? matches[2].substring(0, matches[2].indexOf(holeMatches[1]))
                        : matches[2];
                }
            }
        },
        {
            type: 'EmptyType',
            syntaxTree: [`^${optionalSpaceDelimiter}$`],
            compile({ matches }) {
                return [true, {
                    type: 'EmptyType',
                    declaration: matches.input
                }];
            }
        },
        {
            type: 'HigherLevelSizedType',
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                mandatoryIdentifier,
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({
                matches
            }) {
                return [true, {
                    type: 'HigherLevelSizedType',
                    referenceType: matches[1],
                    minSize: resolveSize(matches[2]),
                    maxSize: resolveSize(matches[3]),
                    hasReferencedSize: resolveReferencedSize(matches[2], matches[3])
                }];
            }
        },
        {
            type: 'Any',
            isPrimitive: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'ANY',
                '(',
                mandatorySpaceDelimiter,
                'DEFINED',
                mandatorySpaceDelimiter,
                'BY',
                mandatorySpaceDelimiter,
                `${mandatoryIdentifier}`,
                ')?'
            ],
            compile({
                matches
            }) {
                return [true, {
                    type: 'Any',
                    referenceType: matches[2]
                }];
            }
        },
        {
            type: 'BitString',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'BIT',
                mandatorySpaceDelimiter,
                'STRING',
                optionalSpaceDelimiter,
                '(?:',
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                blockClosing,
                optionalSpaceDelimiter,
                ')?',
                optionalSize
            ],
            holeTree: [`${mandatoryIdentifier}${optionalSpaceDelimiter}\\((\\d+)\\)`],
            compile({
                holeRegexp,
                matches
            }) {
                const bitStringList = [];
                let bitStringItemMatches;
                while ((bitStringItemMatches = holeRegexp.exec(matches[1])) !== null) {
                    bitStringList.push({
                        identifier: bitStringItemMatches[1],
                        value: bitStringItemMatches[2]
                    });
                }

                holeRegexp.lastIndex = 0;
                return [true, {
                    type: 'BitString',
                    minSize: resolveSize(matches[2]),
                    maxSize: resolveSize(matches[3]),
                    hasReferencedSize: resolveReferencedSize(matches[2], matches[3]),
                    list: bitStringList
                }];
            }
        },
        {
            type: 'Boolean',
            isPrimitive: true,
            isLeafType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'BOOLEAN'
            ],
            compile() {
                return [true, {
                    type: 'Boolean'
                }]
            }
        },
        {
            type: 'Choice',
            isPrimitive: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'CHOICE',
                optionalSpaceDelimiter,
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                optionalSpaceDelimiter,
                blockClosing
            ],
            holeTree: [`(${typeHole}${listDelimiter}${optionalSpaceDelimiter})`],
            compile: compileList.bind(null, 'Choice')
        },
        {
            type: 'Enumerated',
            isPrimitive: true,
            isLeafType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'ENUMERATED',
                optionalSpaceDelimiter,
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                blockClosing
            ],
            holeTree: [`${mandatoryIdentifier}${optionalSpaceDelimiter}\\((\\d+)\\)`],
            compile({
                holeRegexp,
                matches
            }) {
                const enumeratedList = [];
                let enumeratedItemMatches;
                while ((enumeratedItemMatches = holeRegexp.exec(matches[1])) !== null) {
                    enumeratedList.push({
                        identifier: enumeratedItemMatches[1],
                        value: enumeratedItemMatches[2]
                    });
                }

                holeRegexp.lastIndex = 0;
                return [true, {
                    type: 'Enumerated',
                    list: enumeratedList
                }];
            }
        },
        {
            type: 'GraphicString',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'GraphicString',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'GraphicString',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'IA5String',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'IA5String',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'IA5String',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'Integer',
            isPrimitive: true,
            isLeafType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'INTEGER',
                '(?:',
                optionalSpaceDelimiter,
                '(?:(\\d+)|(?:',
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                blockClosing,
                ')))?'
            ],
            holeTree: [`${mandatoryIdentifier}${optionalSpaceDelimiter}\\((\\d+)\\)`],
            compile({
                holeRegexp,
                matches
            }) {
                const integerList = [];
                if (matches[1]) {
                    integerList.push({
                        value: matches[1]
                    });
                } else {
                    let integerItemMatches;
                    while ((integerItemMatches = holeRegexp.exec(matches[2])) !== null) {
                        integerList.push({
                            identifier: integerItemMatches[1],
                            value: integerItemMatches[2]
                        });
                    }
                    holeRegexp.lastIndex = 0;
                }
                
                return [true, {
                    type: 'Integer',
                    list: integerList
                }];
            }
        },
        {
            type: 'Null',
            isPrimitive: true,
            isLeafType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                `NULL`
            ],
            compile() {
                return [true, {
                    type: 'Null'
                }];
            }
        },
        {
            type: 'ObjectIdentifier',
            isPrimitive: true,
            syntaxTree: [
                '(?:^',
                optionalSpaceDelimiter,
                'OBJECT',
                mandatorySpaceDelimiter,
                'IDENTIFIER',
                ')(?:^',
                optionalSpaceDelimiter,
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                blockClosing,
                ')?'
            ],
            holeTree: [`${mandatoryIdentifier}${optionalSpaceDelimiter}(\\((\\d+)\\))`],
            compile({
                holeRegexp,
                matches
            }) {
                const objectIdentifierList = [];
                let objectIdentifierItemMatches;
                while ((objectIdentifierItemMatches = holeRegexp.exec(matches[1])) !== null) {
                    objectIdentifierList.push({
                        identifier: objectIdentifierItemMatches[1],
                        value: objectIdentifierItemMatches[3]
                    });
                }

                holeRegexp.lastIndex = 0;
                return [true, {
                    type: 'ObjectIdentifier',
                    list: objectIdentifierList
                }];
            }
        },
        {
            type: 'OctetString',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'OCTET',
                mandatorySpaceDelimiter,
                'STRING',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'OctetString',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'PrintableString',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'PrintableString',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'PrintableString',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'VisibleString',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'VisibleString',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'VisibleString',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'UTF8String',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'UTF8String',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'UTF8String',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'T61String',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'T61String',
                optionalSpaceDelimiter,
                optionalSize
            ],
            compile({ matches }) {
                return [true, {
                    type: 'T61String',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2])
                }];
            }
        },
        {
            type: 'UTCTime',
            isPrimitive: true,
            isLeafType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'UTCTIME'
            ],
            compile() {
                return [true, {
                    type: 'UTCTime'
                }];
            }
        },
        {
            type: 'Sequence',
            isPrimitive: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'SEQUENCE',
                optionalSpaceDelimiter,
                blockOpening,
                optionalSpaceDelimiter,
                `([^]*)`,
                blockClosing
            ],
            holeTree: [`(${typeHole}${listDelimiter}${optionalSpaceDelimiter})`],
            compile: compileList.bind(null, 'Sequence')
        },
        {
            type: 'SequenceOf',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'SEQUENCE',
                mandatorySpaceDelimiter,
                optionalSize,
                optionalSpaceDelimiter,
                'OF',
                mandatorySpaceDelimiter,
                mandatoryIdentifier
            ],
            compile({
                matches
            }) {
                return [true, {
                    type: 'SequenceOf',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2]),
                    referenceType: matches[3]
                }];
            }
        },
        {
            type: 'Set',
            isPrimitive: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'SET',
                optionalSpaceDelimiter,
                blockOpening,
                optionalSpaceDelimiter,
                listHole,
                optionalSpaceDelimiter,
                blockClosing
            ],
            holeTree: [`(${typeHole}${listDelimiter}${optionalSpaceDelimiter})`],
            compile: compileList.bind(null, 'Set')
        },
        {
            type: 'SetOf',
            isPrimitive: true,
            isLeafType: true,
            isSizedType: true,
            syntaxTree: [
                `^${optionalSpaceDelimiter}`,
                tag,
                optionalSpaceDelimiter,
                'SET',
                mandatorySpaceDelimiter,
                optionalSize,
                optionalSpaceDelimiter,
                'OF',
                mandatorySpaceDelimiter,
                mandatoryIdentifier
            ],
            compile({
                matches
            }) {
                return [true, {
                    type: 'SetOf',
                    minSize: resolveSize(matches[1]),
                    maxSize: resolveSize(matches[2]),
                    hasReferencedSize: resolveReferencedSize(matches[1], matches[2]),
                    referenceType: matches[3]
                }];
            }
        }
    ];

    return syntaxTrees.map(typeCompilerFactory);

    function compileList (type, {
        holeRegexp,
        matches
    }) {
        const list = [];
        let itemMatches;
        while ((itemMatches = holeRegexp.exec(matches[1])) !== null) {
            if (itemMatches[2].search(ellipisRegexp) == -1) {
                list.push({
                    declaration: itemMatches[2]
                });
            }
        }

        holeRegexp.lastIndex = 0;
        return [true, {
            type: type,
            list: list
        }];
    }

    function typeCompilerFactory(typeDescriptor) {
        const {
            type,
            syntaxTree,
            holeTree,
            compile,
            isPrimitive,
            isLeafType
        } = typeDescriptor,
        regexp = new RegExp(syntaxTreetoString(syntaxTree)),
        holeRegexp = holeTree ? new RegExp(syntaxTreetoString(holeTree), 'g') : undefined;

        return {
            type: type,
            isPrimitive: isPrimitive,
            isLeafType: isLeafType,
            compile(pieceOfASN) {
                const matches = regexp.exec(pieceOfASN);

                if (matches === null) {
                    return [false, pieceOfASN];
                }

                return compile({
                    holeRegexp: holeRegexp,
                    matches: matches
                });
            }
        };
    }

    function syntaxTreetoString(syntaxTree) {
        const stringify = (acc, val) => acc + val.toString();
        return syntaxTree.reduce(stringify, '');
    }

    function resolveSize (match) {
        return match == 'MAX' ?
            undefined :
            match == 'n' ?
            'definedByNextLevel' :
            match;
    }

    function resolveReferencedSize (...matches) {
        return matches.some(match => match && match != 'MAX' && match != 'n' && match.search(charRegexp) != -1);
    }
}