# Alias Rule Guide

## Grammar

wildcard = `'*'`;

greedy_wildcard = `'[*]'`;

defined_identifier = `[^\s\.]+ -wildcard -greedy_wildcard`

type_accessor = `'.'`;

greedy_accessor = `'..'`;

defined_to_defined_access = `defined_identifier, type_accessor, ( defined_identifier | defined_to_defined_access | defined_to_wildcard_access | greedy_access )`;

wildcard_to_wildcard_access = `wildcard, type_accessor, ( wildcard | wildcard_to_wildcard_access | wildcard_to_defined_access )`;

defined_to_wildcard_access = `defined_identifier, type_accessor, ( wildcard | wildcard_to_wildcard_access | wildcard_to_defined_access )`;

wildcard_to_defined_access = `wildcard, type_accessor, ( defined_identifier | defined_to_defined_access | defined_to_wildcard_access | greedy_access )`;

greedy_access = `defined_identifier, greedy_accessor, ( defined_identifier | defined_to_defined_access | defined_to_wildcard_access | greedy_access )`;

rule = `( defined_identifier | defined_to_defined_access | wildcard_to_wildcard_access | defined_to_wildcard_access | wildcard_to_defined_access | greedy_access | ( greedy_wildcard, type_accessor, ( defined_identifier | defined_to_defined_access | defined_to_wildcard_access | greedy_access )  ), -( wildcard, type_accessor, wildcard [ { , type_accessor, wildcard } ] )`;

## How it works

### The problem

Rules are matched against column accessors. Column accessors are simple column identifiers like `column_1` when the column is not a composite type, or complex column identifiers like `array[1].typeA.propertyA` otherwise. Some composite types are used as properties by other different composite types, i.e., thay can be found at various nesting levels. How do we apply aliases to that kind of type wherever it appears? That's the problem the Alias Rules solve.

### The solution

Nested, recursive placeholders to the rescue! The rule is declared in a similar way of the composite type accessors, i.e., using dots (`.`) as level accessors. See the [grammar](## Grammar) or the [examples](### Examples) below for more details.

1. `*`

[Wildcards](https://en.wikipedia.org/wiki/Wildcard_character) are placeholders represented by a single character. The Alias Rules implements the known wildcard asterisk (`*`), but its functionallity is different: it matches the same characters as the regular expression `[^\s\.]+`, i.e., no spaces or empty characters.

It can be used alone, at the beginning, at the mid and at the end for a rule. If used at the end, it must not be preceded by another wildcard.

2. `[*]`

A matcher that implements a recursive wildcard. It can be used only once in a rule and at the beginning of a rule and cannot be followed by a wildcard. It matches any types at any level before a defined type, i.e., it matches `a.b.c` using the rule `[*].d` against the accessor `a.b.c.d`.

3. `<array_type_identifier>[*]`

This matcher matches arrays. If the sufix `[*]` is not used, no array is matched. It's straightfoward if you think that there is a wildcard there to match any array index. Of course you can used a rule to match only a position of an array, but maybe that's not what you want.

4. `..`

The level accessor is a dot (`.`) and the double dot (`..`) is a greedy accessor. It sticks two type levels, changing the replacing logic: while the rule `a.b.c` tells that the program must replace the `c`, the rule `a.b..c` tells it must replace both `b` and `c`, i.e., while the first case should end up like `a_b_<alias>`, the latter leads to `a_<alias>`. Greedy accessors can be used to stick multiple type levels, e.g., `a..b..c` is a valid rule.

#### Precedence of rules

When many rules are used, they may 'collide' and the program must know which one (or some) it should apply. By default, **rules with the highest precedence weight are applied**. It's important to understand that multiple rules can be applied at once.

That's is possible because each rule tells which type levels should be aliased by the program and there can be multiple rules that define different type levels among each other. For example, considering the accessor `a.b.c.d.e`, we can declare 5 rules and they will all be applied at once if, and only if, each rule matches a single type level and if that type level is different from the matched type levels of all other rules.

That said, what if two (or more) rules 'collide', i.e., matches the same type levels of their siblings? There are two tiebreakers: the **precedence level** and the **index of the last no-wildcard identifier**. The **precedence level** is the number of no-wildcard identifiers defined in a rule, e.g., for the rule `[*].b.*.c.*` the precedence level is 2 and the index of the last no-wildcard identifier is 3. Considering the rule `[*].b.z.c.*`, it has precedence over the latter rule when matching against the accessor `a.b.z.c.f`, because its precedence level is 3; likewise, the rule `[*].b.*.*.d` has precedence over the rule `[*].b.*.c.*`, because, although both have precedence level of 2, the first has the last no-wildcard identifier index being 4 againts 3 from the latter.

### Examples

Below, there are allowed rules and examples of how they work:

1. `a.b.c` or `a..b.c`, they match the exact type hierarchy and replace the last type level by the provided alias. Example of accessor that match the rule and the results using `@` as an alias: `a.b.c` -> `a_b_@`.

2. `a.b..c`, it matches the exact type hierarchy and replace the last sticked type level by the provided alias. Example of accessor that match the rule and the results using `@` as an alias: `a.b.c` -> `a_@`.

3. `*.*.z`, it works matching a `z` at the end of all column names that have their 3rd type level of type `z`, regardless of the parent types and replace the last type by the provided alias. Example of accessors that match the rule and the results using `@` as an alias: `a.b.z` -> `a_b_@`, `a[1].b[1].z` -> `a1_b1_@`.

4. `[*].z`, it works matching a `z` at the end of all column names that have their last type level of type`z`, regardless of the parent types and how deeply nested `z` is, and replace the last type by the provided alias. Example of accessors that match the rule and the results using `@` as an alias: `a.b.c.z` -> `a_b_c_@`, `a.z` -> `a_@`, `z[1].z` -> `z1_@`, `z.z` -> `z_@`.

5. `a[*].c`, it matches any index of an array of type `a` in the first type level followed by a type `c` and replace the last type by the provided alias. Example of accessor that match the rule and the results using `@` as an alias: `a[1].c` -> `a1_@`, `a[99].c` -> `a99_c`.

6. `a[*]..b`, it matches any index of an array of type `a` in the first type level followed by a type `b` and replace the last sticked type level by the provided alias. Example of accessor that match the rule and the results using `@` as an alias: `a[1].c` -> `@1`, `a[99].c` -> `@99`.

Example of invalid rules:

1. `[*]`.

2. `a.b.*.*`, a rule cannot has two (or more) wildcards at its end.

3. `a..*.c`, `*..b.c`, `[*]..b.c`; rules cannot have greedy accessors between wildcards.
