"""Contacts: people we can call, their numbers, and tags on those numbers."""

import contacts_store
import pytest


@pytest.fixture
def store(tmp_path):
    return contacts_store.ContactStore(tmp_path / "contacts.json")


def test_create_a_contact_with_a_number(store):
    c = store.create("Asha Rao", ["98765 43210"])
    [saved] = store.list()
    assert saved["name"] == "Asha Rao" and saved["id"] == c["id"]
    assert [n["number"] for n in saved["numbers"]] == ["+919876543210"]


@pytest.mark.parametrize("name, numbers", [("", ["9876543210"]), ("Asha", ["abc"]),
                                           ("x" * 81, ["9876543210"])])
def test_bad_contacts_are_refused(store, name, numbers):
    with pytest.raises(ValueError):
        store.create(name, numbers)


def test_a_contact_may_start_without_a_number(store):
    assert store.create("Ravi", [])["numbers"] == []


def test_numbers_add_edit_delete_and_no_duplicates(store):
    c = store.create("Asha", ["9876543210"])
    n = store.add_number(c["id"], "9123456780")
    with pytest.raises(ValueError):
        store.add_number(c["id"], "+91 98765 43210")
    store.update_number(c["id"], n["id"], number="9000000001")
    store.delete_number(c["id"], c["numbers"][0]["id"])
    assert [x["number"] for x in store.get(c["id"])["numbers"]] == ["+919000000001"]


def test_rename_and_delete_and_bulk_delete(store):
    a, b, c = (store.create(x, []) for x in ("A", "B", "C"))
    store.rename(a["id"], "Alpha")
    assert store.get(a["id"])["name"] == "Alpha"
    store.delete(a["id"])
    store.delete_many([b["id"], c["id"], "missing"])
    assert store.list() == []


def test_tags_create_edit_delete_and_assign(store):
    t = store.create_tag("Hot lead", "marigold")
    with pytest.raises(ValueError):
        store.create_tag("hot lead", "plum")  # names are unique, ignoring case
    c = store.create("Asha", ["9876543210"])
    nid = c["numbers"][0]["id"]
    store.update_number(c["id"], nid, tags=[t["id"]])
    store.update_tag(t["id"], name="Warm lead", color="teal")
    assert [x["name"] for x in store.tags()] == ["Warm lead"]
    store.delete_tag(t["id"])  # deleting a tag takes it off every number
    assert store.get(c["id"])["numbers"][0]["tags"] == []


def test_an_unknown_tag_cannot_be_assigned(store):
    c = store.create("Asha", ["9876543210"])
    with pytest.raises(ValueError):
        store.update_number(c["id"], c["numbers"][0]["id"], tags=["nope"])


def test_tag_colours_come_from_the_palette(store):
    with pytest.raises(ValueError):
        store.create_tag("Odd", "#ff00ff")


def test_a_contact_can_carry_tags_of_its_own(store):
    t = store.create_tag("VIP", "plum")
    c = store.create("Asha", [])
    store.set_contact_tags(c["id"], [t["id"]])
    assert store.get(c["id"])["tags"] == [t["id"]]
    store.delete_tag(t["id"])
    assert store.get(c["id"])["tags"] == []


def test_contacts_saved_before_contact_tags_existed_have_none(store):
    store.path.write_text('{"contacts": [{"id": "x1", "name": "Old", "numbers": []}], "tags": []}')
    assert store.get("x1").get("tags", []) == []
    store.set_contact_tags("x1", [])


def test_do_not_call_is_kept_and_matches_any_of_the_numbers(tmp_path):
    import contacts_store

    s = contacts_store.ContactStore(tmp_path / "c.json")
    c = s.create("Asha", ["9876543210", "9000000001"])
    assert s.is_dnc("+919000000001") is False
    assert s.set_dnc(c["id"], True)["dnc"] is True
    assert s.is_dnc("+91 90000 00001") is True and s.is_dnc("+919999999999") is False
    assert s.set_dnc(c["id"], False)["dnc"] is False
