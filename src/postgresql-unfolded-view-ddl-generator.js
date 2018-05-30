//@ts-check
// Types used in VIEW generation functionality
/**
 * @typedef {ASTType & SQLType & TypeWithReference} TranslatableType
 */
/**
 * @typedef {Object} ASTType
 * @property {string} identifier
 * @property {TranslatableType | string} type
 * @property {number} [numberOfBytes]
 */ 
/**
 * @typedef {Object} TypeWithReference
 * @property {string} identifier
 * @property {string} type
 * @property {TranslatableType} referencedType
 */
/**
 * @typedef {Object} SQLType 
 * @property {string} identifier
 * @property {string} type
 * @property {TypeWithReference[]} members
 */ 
/**
 * @template K, V
 * @typedef {[K, V]} MapEntry
 */
/** @typedef {MapEntry<string, TranslatableType>} AccessorAndType */

// Types used in VIEW column names aliases functionality
/**
 * @typedef {Object} AliasDescriptor
 * @property {string} rule
 * @property {string} alias
 */
/**
 * @typedef {Object} AliasMatcher
 * @property {RegExp} matcher
 * @property {number[]} groupIndexes
 * @property {'beginning' | 'end' | 'both' | 'none' } recursiveWildcardPosition
 * @property {number} numberOfGroups
 */
/**
 * @typedef {Object} AliasRule
 * @property {AliasDescriptor} descriptor
 * @property {RegExp} rule
 * @property {AliasMatcher} aliasMatcher
 * @property {number} precedenceWeight
 * @property {number} lastDefinedIdentifierIndex
 */
/**
 * @typedef {Object} EligibleGroupCollision
 * @property {AliasRule} rule
 * @property {boolean} enabled
 */

module.exports = {
    postgreSQLUnfoldedViewDDLGenerator: postgreSQLASTToUnfoldedViewDDL,
    forTesting: {
        accessorToIdentifier,
        buildRegexpAliasRules,
        validateFieldAliasRule,
        rulePrecedenceSorter
    }
};

const { logMessage, logError }                                = require('./misc/logger'),
      { partialApply, multiplePartialApply, last } = require('./misc/util'),
      DEFAULT_ARRAY_UNFOLD_RATIO                    = 1,
      POSTGRESQL_IDENTIFIER_MAX_LENGTH              = 63,
      PostgreSQLASTTypes                            = [
          'BitString',
          'Boolean',
          'Choice',
          'Enumerated',
          'Integer',
          'SQLEnumeratedType',
          'SQLType',
          'String',
          'TableReference',
          'Timestamp',
          'TypedCollection',
          'UUID'
      ];

function postgreSQLASTToUnfoldedViewDDL (ast, options) {
    const {
        arrayUnfoldRatio = DEFAULT_ARRAY_UNFOLD_RATIO,
        viewFieldsAliasDefinition = []
    } = options;
    logMessage(`Starting PostgreSQL unfolded view DDL generation...`);

    const aliasRules = buildRegexpAliasRules(viewFieldsAliasDefinition);
    const { tables, sqlTypes } = ast;
    const ddl = tables
        .map(multiplePartialApply(tableToView, sqlTypes, arrayUnfoldRatio, aliasRules))
        .join('\n'.repeat(2));

    logMessage(`PostgreSQL unfolded view DDL generation finished.`);

    return ddl;
}

function sanitizeSQLIdentifier (identifier) {
    return identifier.replace(/\W/g, '_');
}

/**
 * @param {Array<AliasDescriptor>} viewFieldsAliasDescriptor
 * @returns {Array<AliasRule>}
 */
function buildRegexpAliasRules (viewFieldsAliasDescriptor) {
    return viewFieldsAliasDescriptor
        .filter(({ rule }) => validateFieldAliasRule(rule))
        .map(({ rule, alias }) => (
            {
                rule: rule.replace(/-/g, '_'),
                alias: alias.replace(/-/g, '_')
            }
        ))
        .map(({ rule, alias }) => (
            {
                descriptor: { rule, alias },
                rule: buildFieldAliasRegexp(rule),
                aliasMatcher: buildAliasMatcher(rule),
                precedenceWeight: getPrecedenceWeight(rule),
                lastDefinedIdentifierIndex: resolveLastDefinedIdentifierIndex(rule)
            }
        ));
}

/**
 * @param {string} rule 
 * @returns {number}
 */
function resolveLastDefinedIdentifierIndex (rule) {
    return rule
        .split('.')
        .reduce((lastIndexIdentifier, identifier, index) => {
            if (identifier != '*')
                return index;
            return  lastIndexIdentifier;
        }, 0);
}

const arrayRegexp = /^([^[\]\*\s]+)((?:\[\*\])+)$/;
/**
 * @param {string} rule 
 * @returns {AliasMatcher}
 */
function buildAliasMatcher (rule) {
    const { acc: regexpString, definedIndexes: maybeDefinedIndexes } = rule
        .split('.')
        .reduce(({ acc, definedIndexes }, identifier, index, plainRules) => {
            if (identifier == '[*]')
                return {
                    acc: `([^\\s]+)`,
                    definedIndexes
                };

            if (identifier == '*') {
                const isLastItem = index == plainRules.length - 1;
                // A wildcard at the last position means it matches accessors that end at the last
                // defined identifier and accessors that have more identifier levels ahead
                if (isLastItem) {
                    return  {
                        acc: `${acc}\\.?([^\\s]+)?`,
                        definedIndexes
                    };
                }
                
                return {
                    acc: `${acc.length == 0 ? '' : `${acc}\\.`}([^\\s]+)`,
                    definedIndexes
                };
            }

            // Means rule 'a..b'. It adds the index anyway
            if (identifier.length == 0) {
                return {
                    acc,
                    definedIndexes: definedIndexes.concat(index)
                };
            }

            let actualIdentifier = identifier;
            // Arrays
            if (arrayRegexp.test(identifier)) {
                actualIdentifier = identifier.replace(arrayRegexp,
                    (match, identifier, arraysGroup) =>
                        `${identifier}${arraysGroup.replace(/(\[\*\])/g, '\\[\\d\\]')}`);
            }

            return {
                acc: `${acc.length == 0 ? '' : `${acc}\\.`}(${actualIdentifier})`,
                // Even number of items means the last identifier was an empty string, i.e.,
                // in a rule `a..b.c`, the state table for `definedIndexes` is
                // | iteration | state   |
                // |         1 | [0]     |
                // |         2 | [0,1]   | # number of elements is even, so next iteration adds its index
                // |         3 | [0,1,2] | # number of elements is odd, so next iteration discard the state and use its own index
                // |         4 | [3]     |
                definedIndexes: definedIndexes.length % 2 == 0
                    ? definedIndexes.concat(index)
                    : [index]
            };
        }, {
            acc: '',
            definedIndexes: []
        });

    const definedIdentifiers = rule.replace(/\.\./g, '.').split('.');
    
    if (maybeDefinedIndexes.length == 1) {
        return {
            matcher: new RegExp(`^${regexpString}$`),
            groupIndexes: extractAggregatorsFromIndexes(rule, maybeDefinedIndexes),
            recursiveWildcardPosition: resolveRecursiveWildcard(definedIdentifiers),
            numberOfGroups: definedIdentifiers.length
        };
    }

    return {
        matcher: new RegExp(`^${regexpString}$`),
        // For rule 'a..b', the index between the two dots is added anyway, increasing the number of lastDefinedIndexes
        // For example: 'a..b..c' generates `lastDefinedIndexes = [1,2,3,4,5]`, but we need only `[1,2,3]`, i.e,
        // we need `n + 1` indexes from an array of `2n + 1` elements.
        groupIndexes: maybeDefinedIndexes.slice(0, Math.ceil(maybeDefinedIndexes.length / 2)),
        recursiveWildcardPosition: resolveRecursiveWildcard(definedIdentifiers),
        numberOfGroups: definedIdentifiers.length
    };

    function extractAggregatorsFromIndexes (rule, maybeDefinedIndexes) {
        const numberOfAggregatorMatchers = rule
            .split('.')
            .filter(identifier => identifier.length == 0)
            .length;

        return maybeDefinedIndexes
            .map(index => index - numberOfAggregatorMatchers)
            .filter(index => index >= 0);
    }

    function resolveRecursiveWildcard (identifiers) {
        if (identifiers[0] == '[*]' && last(identifiers) == '*') {
            return 'both';
        }
        if (identifiers[0] == '[*]') {
            return 'beginning';
        }
        if (last(identifiers) == '*') {
            return 'end';
        }
        
        return 'none';
    }
}

/**
 * @param {string} rule 
 * @returns {number}
 */
function getPrecedenceWeight (rule) {
    return rule
        .split('.')
        .reduce(({ numberOfidentifiersWithWeight, identifierTypes }, identifier, index, identifiers) => {
            const lastIdentifierType = last(identifierTypes);
            if (arrayRegexp.test(identifier)) {
                if (index == identifiers.length - 1 || lastIdentifierType == 'aggregator') {
                    return {
                        numberOfidentifiersWithWeight: numberOfidentifiersWithWeight + 1,
                        identifierTypes: identifierTypes.concat('array')
                    };
                }

                return {
                    numberOfidentifiersWithWeight,
                    identifierTypes: identifierTypes.concat('array')
                };
            }

            if (identifier == '*' || identifier == '[*]') {
                // An 'array' followed by an 'any' in the end a rule, means the array is significant and `numberOfidentifiersWithWeight`
                // must be incremented.
                // `numberOfidentifiersWithWeight` is already incremented when the transition 'aggregator'>'array' occurs.
                // Thus, it's checked if that transition already happen before incrementing to avoid the erroneous extra
                // incrementation, that is, the transition 'aggregator'>'array'>'any' requires 1 incrementing, not 2.
                if (index == identifiers.length - 1
                    && lastIdentifierType == 'array'
                    && identifierTypes[identifierTypes.length - 2] != 'aggregator') {
                    return {
                        numberOfidentifiersWithWeight: numberOfidentifiersWithWeight + 1,
                        identifierTypes: identifierTypes.concat('any')
                    };
                }

                return {
                    numberOfidentifiersWithWeight,
                    identifierTypes: identifierTypes.concat('any')
                };
            }

            if (identifier == '') {
                // `numberOfidentifiersWithWeight` is already incremented when the transition 'aggregator'>'array' occurs.
                // Thus, it's checked if that transition already happen before incrementing to avoid the erroneous extra
                // incrementation, that is, the transition 'aggregator'>'array'>'aggregator' requires 1 incrementing, not 2.
                if (lastIdentifierType == 'array'
                    && identifierTypes[identifierTypes.length - 2] != 'aggregator') {
                    return {
                        numberOfidentifiersWithWeight: numberOfidentifiersWithWeight + 1,
                        identifierTypes: identifierTypes.concat('aggregator')
                    };
                }

                return {
                    numberOfidentifiersWithWeight,
                    identifierTypes: identifierTypes.concat('aggregator')
                };
            }

            return {
                numberOfidentifiersWithWeight: numberOfidentifiersWithWeight + 1,
                identifierTypes: identifierTypes.concat('defined')
            };
        }, {
            numberOfidentifiersWithWeight: 0,
            identifierTypes: []
        })
        .numberOfidentifiersWithWeight;
}

/**
 * @param {string} rule 
 * @returns {RegExp}
 */
function buildFieldAliasRegexp (rule) {
    const ruleIdentifiers = rule
        .replace(/\.{2,}/g, '.')
        .split('.');
    const parsedRule = ruleIdentifiers
        .reduce((parsedRuleAccumulator, identifier, index, identifiers) =>
            `${parsedRuleAccumulator}${resolveNextParsedPart(identifier, index, identifiers)}`, '');
        
    return new RegExp(`^${parsedRule}$`);

    function resolveNextParsedPart (identifier, index, identifiers) {
        const isWildCard = identifier == '*';
        const isSingleIdentifierRule = identifiers.length == 1;
        const isEndOfRule = !isSingleIdentifierRule && index == identifiers.length - 1;
        const isFirstRule = index == 0;
        
        if (isWildCard && isEndOfRule)
            return `\\.?${parseRuleIdentifier(identifier, index, identifiers)}`;
        if (isWildCard && isSingleIdentifierRule)
            return parseRuleIdentifier(identifier, index, identifiers);
        if (isFirstRule)
            return parseRuleIdentifier(identifier, index, identifiers);
        return `\\.${parseRuleIdentifier(identifier, index, identifiers)}`;
    } 
}

function parseRuleIdentifier (identifier, index, identifiers) {
    if (identifier == '[*]') {
        return '[^\\s]+';
    }
    
    if (identifier == '*') {
        if (index == identifiers.length - 1)
            return '(?:[^\\s]+)?'
        return '[^\\s\\.]+';
    }

    // Array case: `identifier[numeric_index]`, ex.: `address[2]`
    return identifier.replace(arrayRegexp,
        (match, identifier, arraysGroup) =>
            `${identifier}${arraysGroup.replace(/(\[\*\])/g, '\\[\\d\\]')}`);
}

const ruleValidatorRegexps = [
    /\s/,
    /^\./,
    /\.$/,
    /^\S+(?:\.\*){2,}$/,
    /\*\.{2,}[^\s\.]+/,
    /[^\s\.]+\.{2,}\*/,
    /[^\.]+\.\[\*\]/,
    /^\[\*\]$/,
    /^\[\*\]\.\*/
];
/**
 * @param {string} rule 
 * @returns {boolean}
 */
function validateFieldAliasRule (rule) {
    if (rule.length == 0 || !ruleValidatorRegexps.some(regexp => regexp.test(rule)))
        return true;
    logMessage(`Invalid rule '${rule}'. Ignoring it.`);
    return false;
}

/**
 * @param {AliasRule} ruleA
 * @param {AliasRule} ruleB
 * @return {number}
 */
function rulePrecedenceSorter (ruleA, ruleB) {
    const comparisonResult = ruleB.precedenceWeight - ruleA.precedenceWeight;
    if (comparisonResult != 0)
        return comparisonResult;
    return ruleB.lastDefinedIdentifierIndex - ruleA.lastDefinedIdentifierIndex;
}

/**
 * @param {AliasRule} rule 
 * @returns {EligibleGroupCollision}
 */
function groupCollisionFactory (rule) {
    return {
        rule,
        enabled: true
    };
}

/**
 * @param {string} accessor
 * @param {Array<AliasRule>} allMatchingRules 
 * @param {Array<EligibleGroupCollision>} eligibleCollisions 
 * @returns {EligibleGroupCollision|undefined}
 */
function chooseCollisonToUse (accessor, allMatchingRules, eligibleCollisions) {
    if (eligibleCollisions.length == 1)
        return eligibleCollisions[0];

    logMessage([
        `The following VIEW alias rule collisions were found for accessor "${accessor}":`,
        ... eligibleCollisions.map(extractCollisionDescriptor)
    ].join('\n\t'));

    const enabledEligibleCollisions = eligibleCollisions.filter(collision => collision.enabled);
    if (enabledEligibleCollisions.length == 0)
        return undefined;
    const highestPrecedenceCollisions = enabledEligibleCollisions
        .sort((collisionA,collisionB) =>
            collisionB.rule.precedenceWeight - collisionA.rule.precedenceWeight)
        .reduce((collisions, collision) => {
            if (collisions.length == 0)
                return [collision];
            if (last(collisions).rule.precedenceWeight == collision.rule.precedenceWeight)
                return collisions.concat(collision);
            return collisions;
        }, []);

    const chosenCollision = eligibleCollisions
        .filter(collision => highestPrecedenceCollisions.includes(collision))[0];

    if (highestPrecedenceCollisions.length > 1) {
        logMessage([
            `The following VIEW alias rules have the highest precedence for accessor ${accessor}:`,
            ... highestPrecedenceCollisions.map(extractCollisionDescriptor)
        ].join('\n\t'));
        logMessage('');
        logMessage(`There is no way to decide which rule to apply to accessor ${accessor}, so the first declared ` +
            `with the highest precedence is chosen to be applied: ${extractCollisionDescriptor(chosenCollision)}`);
    } else {
        logMessage(`The rule with the highest precedence, chosen to be applied to accessor ${accessor} is: ${extractCollisionDescriptor(chosenCollision)}`);
    }

    // Disablind discarded collisions
    eligibleCollisions
        .filter(collision => chosenCollision != collision)
        .forEach(collision => collision.enabled = false);

    return chosenCollision;

    function extractCollisionDescriptor (collision) {
        return `[${collision.enabled ? 'enabled' : 'disabled'}] ${collision.rule.descriptor.rule} -> ${collision.rule.descriptor.alias}`;
    }
}

/**
 * @param {Array<AliasRule>} aliasRules 
 * @param {string} accessor
 * @returns {string}
 */
function accessorToIdentifier (aliasRules, accessor) {
    const accessorWithoutParentheses = accessor.replace(/[()]/g, '');
    const matchingRules = aliasRules
        .filter(({ rule }) => rule.test(accessorWithoutParentheses))
        .sort(rulePrecedenceSorter);
    
    const resolveRelativeAccessorIndexes = resolveRelativeAccessorIndexesUsing(accessor);
    const ruleEligibleGroupCollisionsByGroupIndex = matchingRules
        .reduce((map, rule) => {
            const { aliasMatcher } = rule;
            const relativeAccessorIndexes = resolveRelativeAccessorIndexes(aliasMatcher);
            relativeAccessorIndexes.forEach(groupIndex => {
                const rulesUsingCurrentGroupIndex = map.get(groupIndex);
                if (rulesUsingCurrentGroupIndex)
                    return map.set(groupIndex, rulesUsingCurrentGroupIndex.concat(groupCollisionFactory(rule)));
                return map.set(groupIndex, [groupCollisionFactory(rule)]);
            });
            
            return map;
        }, new Map());

    const chosenRules = [...ruleEligibleGroupCollisionsByGroupIndex]
        .map(([relativeAccessorIndexes, eligibleCollisions]) => chooseCollisonToUse(accessor, matchingRules, eligibleCollisions))
        .filter(maybeCollision => maybeCollision != undefined)
        .map(collision => collision.rule);

    if (!chosenRules.length)
        return sanitizeAccessor(accessor);

    const aliasedAccessor = chosenRules
        .reduce((accessor, matchingRule) => {
            const { aliasMatcher, descriptor } = matchingRule;
            const { alias } = descriptor;
            const { matcher, groupIndexes } = aliasMatcher;
            const sortedGroupIndexes = groupIndexes.slice().sort();
            const replacer = buildAliasReplacerFunction(alias, sortedGroupIndexes);
            return accessor.replace(matcher, replacer);
        }, accessorWithoutParentheses);

    return sanitizeAccessor(aliasedAccessor);

    function resolveRelativeAccessorIndexesUsing (accessor) {
        const accessorIdentifiers = accessor.split('.');
        const numberOfAccessorLevels = accessorIdentifiers.length;
        return resolveRelativeAccessorIndexes;

        function resolveRelativeAccessorIndexes (aliasMatcher) {
            const {
                groupIndexes,
                numberOfGroups: numberOfRuleGroups,
                recursiveWildcardPosition
            } = aliasMatcher;

            
            if (numberOfAccessorLevels == numberOfRuleGroups
                || recursiveWildcardPosition == 'end') {
                return groupIndexes;
            }

            const groupsOffset = numberOfAccessorLevels - numberOfRuleGroups;
            if (recursiveWildcardPosition == 'beginning') {
                return groupIndexes.map(groupIndex => groupIndex + groupsOffset);
            }

            if (recursiveWildcardPosition == 'both') {
                const { matcher } = aliasMatcher;
                const matchResults = matcher.exec(accessor);
                const matchedGroups = matchResults.slice(1);
                const firstGroupDefinedByAliasMatcher = matchedGroups[groupIndexes[0]];
                const relativeAccessorIndex = accessorIdentifiers.indexOf(firstGroupDefinedByAliasMatcher);
                const relativeOffset = groupIndexes[0] - relativeAccessorIndex;
                if (relativeOffset == 0) {
                    return groupIndexes;
                }
                return groupIndexes.map(groupIndex => groupIndex + relativeOffset);
            }

            logError('Unexpected behaviour. `recursiveWildcardPosition` should never be "none".');
        }
    }
}

const definedArrayRegexp = /^([^[\]\*\s]+)((?:\[\d\])+)$/;
function buildAliasReplacerFunction (alias, sortedGroupIndexes) {
    return replacer;

    function replacer (match, ...remainingArguments) {
        const matchedGroups = remainingArguments
            .slice(0, remainingArguments.length - 2)
            // When there is a wildcard at the end of a rule, it has a optional matching, that is,
            // it can match something or `undefined` and `undefined` leads malformed parsing.
            // Ex.:
            // acessor: `a.b`
            // rule: `a.b.*`
            // with `undefined` -> parsed to `a_c_`
            // without `undefined` -> parsed to `a_c`
            .filter(matchedGroup => matchedGroup != undefined);
        return matchedGroups
            .reduce((acc, matchedGroup, currentIndex) => {
                if (!sortedGroupIndexes.includes(currentIndex))
                    return acc.concat(matchedGroup);

                if (last(sortedGroupIndexes) == currentIndex) {
                    let actualAlias = alias;
                    if (definedArrayRegexp.test(matchedGroup)) {
                        actualAlias = matchedGroup.replace(definedArrayRegexp,
                            (match, identifier, arraysGroup) => `${alias}${arraysGroup}`);
                    }
                    return acc.concat(actualAlias);
                }

                return acc;
            }, [])
            .join('.');
    }
}

function sanitizeAccessor (accessor) {
    return trimIdentifierToMaxLength(
        accessor
            .replace(/_/g, '')
            .replace(/\./g, '_')
            .replace(/[[()\]]/g, ''));
}

function resolveNextLevelAccessor (accessor, type) {
    return type.identifier
        ? `${accessor}.${sanitizeSQLIdentifier(type.identifier)}`
        : accessor;
}

function trimIdentifierToMaxLength (identifier) {
    if (identifier.length <= POSTGRESQL_IDENTIFIER_MAX_LENGTH)
        return identifier;
    return identifier.substring(identifier.length - POSTGRESQL_IDENTIFIER_MAX_LENGTH, identifier.length);
}

function tableToView (sqlTypes, arrayUnfoldRatio, aliasRules, table) {
    const columnNameAndAccessorMap = table.columns
        .map(multiplePartialApply(unfoldColumn, sqlTypes, arrayUnfoldRatio))
        .reduce(partialApply(flattenColumnMaps, aliasRules), new Map());
    const columnNames = [...columnNameAndAccessorMap.keys()];
    const queryColumns = [...columnNameAndAccessorMap.entries()]
        .map(([identifier, accessor]) => `${accessor} AS ${identifier}`);
    return [
        `CREATE OR REPLACE VIEW ${table.identifier}_plain (`,
        `\t${columnNames.join(',\n\t')}`,
        `)`,
        `AS`,
        `SELECT`,
        `\t${queryColumns.join(',\n\t')}`,
        `FROM ${table.identifier};`
    ].join('\n');
}

function unfoldColumn (sqlTypes, arrayUnfoldRatio, column) {
    return translateTypeToDeclaration(
        sqlTypes,
        arrayUnfoldRatio,
        [
            `(${sanitizeSQLIdentifier(column.identifier)})`,
            column.referencedType
        ],
        new Map());
}

function flattenColumnMaps (aliasRules, accMap, map) {
    [...map.keys()]
        .forEach(accessor =>
            accMap.set(
                sanitizeSQLIdentifier(accessorToIdentifier(aliasRules, accessor)),
                accessor));
    return accMap;
}

/*** 
 * @param {TranslatableType[]} sqlTypes
 * @param {number} arrayUnfoldRatio
 * @param {AccessorAndType} accessorTypeTuple
 * @param {Map} idTypeMap
 * @return {Map}
 */
function translateTypeToDeclaration (sqlTypes, arrayUnfoldRatio, accessorTypeTuple, idTypeMap) {
    const [accessor, type] = accessorTypeTuple;
    // Check composite type
    switch (type.type) {
        case 'Choice':
            const actualType = sqlTypes.find(sqlType => sqlType.identifier == type.identifier);
            return translateTypeToDeclaration(
                sqlTypes,
                arrayUnfoldRatio,
                [
                    accessor,
                    actualType
                ],
                idTypeMap);
        case 'SQLType':
            type.members.forEach(member =>
                translateTypeToDeclaration(
                    sqlTypes,
                    arrayUnfoldRatio,
                    [
                        resolveNextLevelAccessor(accessor, member),
                        member.referencedType
                    ],
                    idTypeMap));
            return idTypeMap;
        case 'TypedCollection':
            // PostgreSQL array index starts at 1
            for (let counter = 1; counter <= arrayUnfoldRatio; counter++)
                translateTypeToDeclaration(
                    sqlTypes,
                    arrayUnfoldRatio,
                    [
                        `${accessor}[${counter}]`,
                        type.referencedType
                    ],
                    idTypeMap);
            return idTypeMap;
    }
    return idTypeMap.set(
        accessor,
        sanitizeSQLIdentifier(
            resolveSimpleTypeDeclaration(type)));
}

/**
 * @param {ASTType} type
 * @return {string}
 */
function resolveSimpleTypeDeclaration (type) {
    switch (type.type) {
        case 'Enumerated':
        case 'SQLEnumeratedType':
            return buildReferenceTypeDeclaration(type);
        case 'BitString':
            return buildBitStringDeclaration(type);
        case 'Boolean':
        case 'Null':
            return buildBooleanDeclaration();
        case 'EmptyType':
            return `${buildStringDeclaration()}[]`;
        case 'Integer':
            return buildIntegerTypeDeclaration(type);
        case 'String':
            return buildStringSizeDeclaration();
        case 'TableReference':
        case 'UUID':
            return buildUUIDDeclaration();
        case 'Timestamp':
            return buildTimestampDeclaration();
        case 'Date':
            return buildDateDeclaration();
        case 'Time':
            return buildTimeDeclaration();
        default:
            throw new Error(`SQL AST Type not recognized. Provided: ${type.type}. Expected: ${PostgreSQLASTTypes.join(' or ')}.`);
    }
}

/**
 * @param {{ identifier: string, size?: number }} param0 
 * @return {string}
 */
function buildBitStringDeclaration ({ identifier, size }) {
    if (size === undefined) {
        return identifier;
    }
    return `varbit` + (size ? `(${size})` : '');
}

function buildBooleanDeclaration () {
    return 'bool';
}

/**
 * @param {{ numberOfBytes?: number }} param0 
 * @return {string}
 */
function buildIntegerTypeDeclaration ({ numberOfBytes }) {
    if (numberOfBytes === undefined) {
        return 'int';
    }

    if (numberOfBytes <= 2) {
        return 'smallint';
    }

    if (numberOfBytes <= 4) {
        return 'int';
    }

    return 'bigint';
}

function buildReferenceTypeDeclaration ({ identifier }) {
    return identifier;
}

function buildStringSizeDeclaration (/*{ size, isVariable }*/) {
    return buildStringDeclaration();
    /**
     * There's no performance advantage to use the `char` type or any
     * size limitation in PostgreSQL. See:
     * https://www.postgresql.org/docs/8.3/static/datatype-character.html
     */
    /*return (isVariable ? 'var' : '') + 'char' + (size ? `(${size})` : '');*/
}

function buildStringDeclaration () {
    return 'varchar';
}

function buildUUIDDeclaration () {
    return 'uuid';
}

function buildTimestampDeclaration () {
    return 'timestamp';
}

function buildTimeDeclaration () {
    return 'time';
}

function buildDateDeclaration () {
    return 'date';
}