const { forTesting } = require('./postgresql-unfolded-view-ddl-generator');

const {
    accessorToIdentifier,
    buildRegexpAliasRules,
    validateFieldAliasRule,
    rulePrecedenceSorter
} = forTesting;

it('hyphen and underline substitution, a-b_c.d_e.f', () => {
    const alias = 'dgi';
    const viewFieldsAliasDescriptor = [
        {
            rule: 'ei-bi_ci.di_i.eff',
            alias
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    // Fails because there's a hyphen. The module receives accessors from other modules
    // with no hyphens because PostgreSQL requires wrappers when using hypens to name
    // entities. There's is no case where an accessor with hypen is expected.
    const accessor1 = 'ei-bi_ci.di_i.eff';
    expect(
        accessorToIdentifier(rules, accessor1)
    ).not.toBe(`eibici_dii_${alias}`);

    const accessor2 = 'ei_bi_ci.di_i.eff';
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`eibici_dii_${alias}`);
});

it('alias without wildcards, a.b.c, a.b..c, a..b.c', () => {
    const alias = 'nodeIPV4Address';
    const viewFieldsAliasDescriptor = [
        {
            rule: 'nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address',
            alias
        },
        {
            rule: 'nodeAddress.iPBinaryAddress..iPBinV4Address',
            alias
        },
        {
            rule: 'iPAddress..iPBinaryAddress.iPBinV4Address',
            alias
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const accessor1 = 'nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address';
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`nodeAddress_iPAddress_iPBinaryAddress_${alias}`);

    const accessor2 = 'nodeAddress.iPBinaryAddress.iPBinV4Address';
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`nodeAddress_${alias}`);

    const accessor3 = 'iPAddress.iPBinaryAddress.iPBinV4Address';
    expect(
        accessorToIdentifier(rules, accessor3)
    ).toBe(`iPAddress_iPBinaryAddress_${alias}`);
});

it('alias with final wildcard, a.b.*, a..b.*', () => {
    const alias = 'nodeIPBinarryAddress';
    const viewFieldsAliasDescriptor = [
        {
            rule: 'nodeAddress.iPAddress.*',
            alias
        },
        {
            rule: 'nodeAddress..iPBinV4Address.*',
            alias
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const sufix1 = 'iPBinaryAddress';
    const sufix2 = 'iPBinV4Address';
    const accessor1 = `nodeAddress.iPAddress.${sufix1}.${sufix2}`;
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`nodeAddress_${alias}_${sufix1}_${sufix2}`);

    const accessor2 = `nodeAddress.iPBinV4Address.${sufix1}.${sufix2}`;
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`${alias}_${sufix1}_${sufix2}`);
});

it('alias with wildcards first, *.b, *.*.c, [*].b', () => {
    const alias1 = 'gorbachev';
    const alias2 = 'binAdd';
    const alias3 = 'marx';
    const viewFieldsAliasDescriptor = [
        {
            rule: '*.iPAddress.iPBinaryAddress.iPBinV4Address',
            alias: alias1
        },
        {
            rule: '*.*.iPBinaryAddress',
            alias: alias2
        },
        {
            rule: '[*].lastOctet',
            alias: alias3
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const prefix1 = 'nodeAddress';
    const prefix2 = 'iPAddress';
    const accessor1 = `${prefix1}.iPAddress.iPBinaryAddress.iPBinV4Address`;
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`${prefix1}_iPAddress_iPBinaryAddress_${alias1}`);

    const accessor2 = `${prefix1}.${prefix2}.iPBinaryAddress`;
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`${prefix1}_${prefix2}_${alias2}`);

    const accessor3 = 'nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address.lastOctet';
    expect(
        accessorToIdentifier(rules, accessor3)
    ).toBe(`nodeAddress_iPAddress_iPBinaryAddress_iPBinV4Address_${alias3}`);
});

it('alias with wildcards in between, *.b.c.*, *.b..c.*, *.b.*.d.*, *.*.c.*.e', () => {
    // Should apply alias in the last level without wildcard, for example the 'd' in '*.b.*.d.*'
    const alias1 = 'binIp';
    const alias2 = 'v4Ip';
    const alias3 = 'binIpV4';
    
    const viewFieldsAliasDescriptor = [
        {
            rule: '*.iPV6Address.iPBinaryAddress.*',
            alias: alias1
        },
        {
            rule: '*.macAddress..iPBinaryAddress.*',
            alias: alias1
        },
        {
            rule: '*.iPAddress.*.iPBinV4Address.*',
            alias: alias2
        },
        {
            rule: '*.*.iPBinaryAddress.*.lastOctet',
            alias: alias3
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const accessor1 = `nodeAddress.iPV6Address.iPBinaryAddress.firstOctet`;
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`nodeAddress_iPV6Address_${alias1}_firstOctet`);

    const accessor2 = `nodeAddress.macAddress.iPBinaryAddress.firstOctet`;
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`nodeAddress_${alias1}_firstOctet`);

    const accessor3 = `nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address.firstOctet`;
    expect(
        accessorToIdentifier(rules, accessor3)
    ).toBe(`nodeAddress_iPAddress_iPBinaryAddress_${alias2}_firstOctet`);

    // Apply 3rd and 4th rules
    const accessor4 = `nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address.lastOctet`;
    expect(
        accessorToIdentifier(rules, accessor4)
    ).toBe(`nodeAddress_iPAddress_iPBinaryAddress_${alias2}_${alias3}`);

    const accessor5 = `nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address`;
    expect(
        accessorToIdentifier(rules, accessor5)
    ).toBe(`nodeAddress_iPAddress_iPBinaryAddress_${alias2}`);
});

it('invalid rules, a.*.*[.*(...)]', () => {
    const alias = 'whatever';
    const viewFieldsAliasDescriptor = [
        {
            rule: 'nodeAddress.iPAddress.*.*',
            alias
        },
        {
            rule: 'nodeAddress.[*]',
            alias
        },
        {
            rule: '[*]',
            alias
        }
    ];

    expect(
        viewFieldsAliasDescriptor.some(validateFieldAliasRule)
    ).toBeFalsy();

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const accessor = 'nodeAddress.iPAddress.iPBinaryAddress.iPBinV4Address';
    expect(
        accessorToIdentifier(rules, accessor)
    ).toBe(accessor.replace(/\./g, '_'));
});

it('precedence for rules', () => {
    const viewFieldsAliasDescriptor1 = [
        {
            rule: 'a.*',
            alias: 'vladimir'
        },
        {
            rule: 'a.b.*',
            alias: 'karl'
        }
    ];

    expect(
        buildRegexpAliasRules(viewFieldsAliasDescriptor1)
            .sort(rulePrecedenceSorter)[0].descriptor.alias
    ).toBe('karl');
    
    const viewFieldsAliasDescriptor2 = [
        {
            rule: '*.b.*.d.*',
            alias: 'cappuccino'
        },
        {
            rule: '*.*.*.d.*',
            alias: 'expresso'
        }
    ];

    expect(
        buildRegexpAliasRules(viewFieldsAliasDescriptor2)
            .sort(rulePrecedenceSorter)[0].descriptor.alias
    ).toBe('cappuccino');

    const viewFieldsAliasDescriptor3 = [
        {
            rule: '*.*.c.d.*',
            alias: 'digimon'
        },
        {
            rule: '*.b.*.*.e',
            alias: 'pokemon'
        }
    ];

    expect(
        buildRegexpAliasRules(viewFieldsAliasDescriptor3)
            .sort(rulePrecedenceSorter)[0].descriptor.alias
    ).toBe('pokemon');
});

it('multiple rules appliance', () => {
    const viewFieldsAliasDescriptor = [
        {
            rule: '[*].lilith.*',
            alias: 'matthew'
        },
        {
            rule: '[*].persefone.*',
            alias: 'barbarian'
        },
        {
            rule: '[*].botas.*',
            alias: 'james'
        },
        {
            rule: '[*].sonia.*',
            alias: 'regina'
        },
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const accessor1 = `lilith.persefone.botas.sonia`;
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`lilith_barbarian_james_regina`);

    const accessor2 = `lucas.lilith.sonia.botas.persefone.raissa`;
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`lucas_matthew_regina_james_barbarian_raissa`);
});

it('appling to arrays, accessor a[1].b.c for rule a.b.*, a.b[1] for rule a..b[*]', () => {
    const alias = 'w';
    const viewFieldsAliasDescriptor = [
        {
            rule: 'a[*].b.*',
            alias
        },
        {
            rule: 'a..b[*]',
            alias
        }
    ];

    const rules = buildRegexpAliasRules(viewFieldsAliasDescriptor);

    const accessor1 = `a[1].b.c`;
    expect(
        accessorToIdentifier(rules, accessor1)
    ).toBe(`a1_${alias}_c`);

    const accessor2 = `a.b[1]`;
    expect(
        accessorToIdentifier(rules, accessor2)
    ).toBe(`${alias}1`);
});