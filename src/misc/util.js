const stringSorter = Intl.Collator.call();

module.exports = {
    applier: applier,
    argumentsToArray: argumentsToArray,
    castArray: castArray,
    chainTests: chainTests,
    compose: compose,
    sortStrings: sortStrings,
    concatReducers: concatReducers,
    capitalize: capitalize,
    extract: extract,
    extractProperty: extractProperty,
    findBy: findBy,
    first: objectSafeFirst,
    flatten: flatten,
    flattenDeep: flattenDeep,
    flattenedFromFunction: flattenedFromFunction,
    groupMembers: groupMembers,
    identity: identity,
    isBitString: isBitString,
    isChoice: isChoice,
    isCollection: isCollection,
    isConsideredTableReferenceType: isConsideredTableReferenceType,
    isEmptyType: isEmptyType,
    isEnumerated: isEnumerated,
    isNull: isNull,
    isSequence: isSequence,
    isSequenceOf: isSequenceOf,
    isSet: isSet,
    isSetOf: isSetOf,
    isSQLEnumeratedType: isSQLEnumeratedType,
    isSQLType: isSQLType,
    isSQLTypeReference,
    isString,
    isTableReference: isTableReference,
    isTypedCollection: isTypedCollection,
    last: objectSafeLast,
    not: not,
    multiplePartialApply: multiplePartialApply,
    partialApply: partialApply,
    pipe: pipe,
    separate: separate,
    remove: remove,
    removeRepeated: removeRepeated,
    separateTransforming: separateTransforming,
    take: take,
    transduce: transduce,
    transducer: transducer,
    transformer: transformer
};

function multiplePartialApply (fn, ...args) {
    return args.reduce(partialApply, fn);
}

function partialApply (fn, arg) {
    return (...args) => fn(arg, ...args);
}

function isConsideredTableReferenceType (type) {
    return type
        && (type.type == 'TableReference'
            || (type.type == 'TypedCollection'
                && isConsideredTableReferenceType(type.referencedType)));
}

function capitalize (s) {
    return s[0].toUpperCase() + s.slice(1);
}

function removeRepeated (arr) {
    return [...new Set(arr)];
}

function remove (arr, item) {
    arr.splice(arr.indexOf(item), 1);
    return arr;
}

function sortStrings (s1, s2) {
    return stringSorter.compare(s1, s2);
}

function isString (type) {
    return type.type == 'String';
}

function isBitString (type) {
    return type.type == 'BitString';
}

function isNull (type) {
    return type.type == 'Null';
}

function isChoice (type) {
    return type.type == 'Choice';
}

function isCollection (type) {
    return type.type == 'Collection';
}

function isSet (type) {
    return type.type == 'Set';
}

function isSetOf (type) {
    return type.type == 'SetOf';
}

function isSequence (type) {
    return type.type == 'Sequence';
}

function isSequenceOf (type) {
    return type.type == 'SequenceOf';
}

function isEnumerated (type) {
    return type.type == 'Enumerated';
}

function isSQLEnumeratedType (type) {
    return type.type == 'SQLEnumeratedType';
}

function isEmptyType (type) {
    return type.type == 'EmptyType';
}

function isSQLType (type) {
    return type.type == 'SQLType';
}

function isSQLTypeReference (type) {
    return type.type == 'SQLTypeReference';
}

function isTypedCollection (type) {
    return type.type == 'TypedCollection';
}

function isTableReference (type) {
    return type.type == 'TableReference';
}

function pipe (...fns) {
    if (!fns.length) {
        throw new Error('Provide at least one function to build a pipe.');
    }

    return fns.reduce(_pipe);
}

function compose (...fns) {
    if (!fns.length) {
        throw new Error('Provide at least one function to be composed.');
    }

    return fns.reduceRight(_pipe);
}

function _pipe (f, g) {
    return (...args) => g(f(...args));
}

function findBy (mapper1) {
    if (typeof mapper1 == 'string') {
        mapper1 = extractProperty(mapper1);
    }

    return mapper2 => {
        if (typeof mapper2 == 'string') {
            mapper2 = extractProperty(mapper2);
        }

        return arr => value => arr.find(el => mapper1(el) === mapper2(value));
    };
}

function extractProperty (propertyName) {
    return el => el[propertyName];
}

function transduce (arr) {
    return seed => filters => mappers => reducers =>
        arr.reduce(transducer(filters)(mappers)(reducers), seed);
}

function transducer (filters) {
    return mappers => reducers => {
        const reducersPipe = pipe(...castArray(reducers)),
        mappersPipe = pipe(...castArray(mappers)),
        _filters = castArray(filters);

        return (seed, a) =>
            _filters.every(applier(a)) ?
                reducersPipe(seed, mappersPipe(a)) :
                seed;
    };
}

function applier (...args) {
    return f => f(...args);
}

function transformer (mappers) {
    return transducer([])(mappers)((identityArr, el) => (identityArr.push(el), identityArr));
}

function separate (test, arr) {
    return separateTransforming(test, identity, identity, arr);
}

function separateTransforming (test, tf1, tf2, arr) {
    return arr
        .reduce(([a, b, sharedArray], v) =>
            (test(v, sharedArray) ?
                a.push(tf1(v, sharedArray)) :
                b.push(tf2(v, sharedArray)),
                [a, b, sharedArray]),
            [[], [], []]);
}

function identity (a) {
    return a;
}

function extract (index, arr) {
    return arr[index];
}

function not (fn) {
    return (...args) => !fn(...args);
}

function flatten (arr) {
    return arr.reduce(partialApply(flattenedFromFunction, identity), []);
}

function flattenDeep (arr) {
    return arr.reduce(partialApply(flattenedFromFunction, pipe(castArray, flattenDeep)), []);
}

function flattenedFromFunction (fn, accArr, item) {
    accArr.push(...castArray(fn(item)));
    return accArr;
}

function castArray (item) {
    if (Array.isArray(item)) {
        return item;
    } else if (item instanceof Set || item instanceof Map) {
        return [...item];
    } else if (item === undefined) {
        return [];
    }
    return [item];
}

function concatReducers (...fns) {
    return flattenedFromFunction.bind(null, item =>
        fns.reduce(flattenedFromFunction.bind(null, fn => fn(item)), []));
}

function chainTests (...tests) {
    return val => tests.reduce((result, test) => result && test(val), true);
}

function groupMembers (memberIdentifiers) {
    return (allMembersArray, object) => (
        memberIdentifiers.forEach((memberIdentifier, index) =>
            allMembersArray[index].push(...castArray(object[memberIdentifier]))
        ), allMembersArray
    );
}

function argumentsToArray (...args) {
    return args;
}

function objectSafeFirst (maybeIterable) {
    if (maybeIterable[Symbol.iterator] === 'function') {
        return first(maybeIterable)[0];
    }
    
    if (maybeIterable instanceof Object) {
        return first(Object.values(maybeIterable))[0];
    }

    return maybeIterable;
}

function objectSafeLast (maybeIterable) {
    if (maybeIterable[Symbol.iterator] === 'function') {
        return last(maybeIterable)[0];
    }
    
    if (maybeIterable instanceof Object) {
        return last(Object.values(maybeIterable))[0];
    }

    return maybeIterable;
}

function first (iterable) {
    return take(1, [...iterable]);
}

function last (iterable) {
    return take(1, [...iterable].reverse());
}

function take (numberOfItemsToTake, iterable) {
    return [...iterable]
        .reduce(({ numberOfItemsToTake, taken }, item) => {
                if (!numberOfItemsToTake)
                    return { numberOfItemsToTake, taken };
                return {
                    numberOfItemsToTake: numberOfItemsToTake - 1,
                    taken: taken.concat(item)
                };
            }, {
                numberOfItemsToTake,
                taken: []
            })
        .taken;
}