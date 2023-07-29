export function findByName(list: Array<any>, name: any) {
    return [...list].find((item) => item.name === name);
}

export function findIndexByName(list: Array<any>, name: any) {
    return [...list].findIndex((item) => item.name === name);
}

export function deleteByName(list: Array<any>, name: any) {
    list = [...list];
    const idx = findIndexByName(list, name);
    list.splice(idx, 1);
    return list;
}

export function updateByName(list: Array<any>, name: any, newItem: any) {
    const idx = findIndexByName(list, name);
    return [...list][idx] = newItem;
}
