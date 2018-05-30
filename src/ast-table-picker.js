const {
    isChoice,
    isSet,
    isSetOf,
    isSequence,
    isSequenceOf,
    identity,
    separate
} = require('./misc/util');

module.exports = filterElegibleTypesForTables;

function filterElegibleTypesForTables (asn_ast) {
    const [firstLevelListTypesFromChoiceTypes, listTypes] = separateListTypes(identity, undefined, [[], []], asn_ast),
    [secondaryLevelListTypesFromChoiceTypes] = listTypes
        .filter(isTypeVariableListType)
        .reduce(separateListTypes.bind(null, type => type.internalType.list, () => listTypes), [[], []]);
    return firstLevelListTypesFromChoiceTypes.concat(secondaryLevelListTypesFromChoiceTypes);

    function separateListTypes (typeTransformer, listTypeTransformer, [listTypesFromChoiceTypes, generalListTypes], types) {
        const [choiceTypes, listTypes] = separate(type => (type.internalType || type.referenceType).type == 'Choice',
            typeTransformer(types).filter(isListType)),
        choiceListTypes = choiceTypes.reduce((acc, type) => (acc.push(...(type.internalType || type.referenceType).list), acc), []),
        actualListTypes = listTypeTransformer ? listTypeTransformer(listTypes) : listTypes,
        choiceReferenceTypes = choiceListTypes.map(type => type.referenceType),
        fromChoiceTypes = actualListTypes
            .filter(type => choiceReferenceTypes.indexOf(type) != -1);
            
        listTypesFromChoiceTypes.push(...fromChoiceTypes);
        generalListTypes.push(...listTypes);

        return [listTypesFromChoiceTypes, generalListTypes];
    }

    function isTypeVariableListType (type) {
        const referencedTypeParameterName = checkReferencedParameterName(type);
        if (!referencedTypeParameterName) {
            return false;
        }

        return isChoice(type[referencedTypeParameterName]) ||
            isSet(type[referencedTypeParameterName]) ||
            isSequence(type[referencedTypeParameterName]);
    }

    function isListType (type) {
        const referencedTypeParameterName = checkReferencedParameterName(type);
        if (!referencedTypeParameterName) {
            return false;
        }

        return isChoice(type[referencedTypeParameterName]) ||
            isSet(type[referencedTypeParameterName]) ||
            isSequence(type[referencedTypeParameterName]) ||
            isSetOf(type[referencedTypeParameterName]) ||
            isSequenceOf(type[referencedTypeParameterName]);
    }

    function checkReferencedParameterName (type) {
        if (type.referenceType) {
            return 'referenceType';
        } else if (type.internalType) {
            return 'internalType';
        }
    }
}