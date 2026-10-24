"""The notifications feed: what changed in the Studio, and where."""

import activity
import pytest


@pytest.fixture
def feed(tmp_path):
    return activity.ActivityLog(tmp_path / "activity.jsonl")


def test_newest_first_with_a_link_to_the_change(feed):
    feed.add("contact", "Added contact Asha", view="contacts", ref="c1", actor="Aditya")
    feed.add("prompt", "Edited prompt Reminder", view="agents", ref="ag_1/pr_1", actor="Aditya")
    items = feed.recent()
    assert [i["text"] for i in items] == ["Edited prompt Reminder", "Added contact Asha"]
    assert items[0]["view"] == "agents" and items[0]["ref"] == "ag_1/pr_1"


def test_unread_counts_what_came_after_the_last_look(feed):
    feed.add("contact", "one", view="contacts")
    seen = feed.recent()[0]["at"]
    feed.add("contact", "two", view="contacts")
    assert feed.unread(since=seen) == 1
    assert feed.unread(since=None) == 2


def test_the_feed_is_capped(feed):
    for i in range(activity.MAX_ITEMS + 30):
        feed.add("contact", f"n{i}", view="contacts")
    assert len(feed.recent(limit=10_000)) == activity.MAX_ITEMS


def test_text_is_trimmed_and_a_bad_view_is_dropped(feed):
    feed.add("x", "y" * 500, view="../../etc")
    item = feed.recent()[0]
    assert len(item["text"]) <= activity.MAX_TEXT and item["view"] is None


def test_a_corrupt_line_is_skipped(feed):
    feed.add("contact", "ok", view="contacts")
    with feed.path.open("a", encoding="utf-8") as f:
        f.write("not json\n")
    assert [i["text"] for i in feed.recent()] == ["ok"]
