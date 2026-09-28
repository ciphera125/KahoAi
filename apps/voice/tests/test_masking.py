import pytest
from masking import mask_sensitive


@pytest.mark.parametrize(
    "spoken",
    [
        "234567891234",
        "2345 6789 1234",
        "2345-6789-1234",
        "2 3 4 5 6 7 8 9 1 2 3 4",
        "२३४५६७८९१२३४",
    ],
)
def test_aadhaar_is_masked_however_it_is_grouped(spoken):
    out = mask_sensitive(f"my aadhaar is {spoken} okay")
    assert out == "my aadhaar is XXXX XXXX 1234 okay"


@pytest.mark.parametrize("spoken", ["ABCDE1234F", "abcde1234f", "A B C D E 1 2 3 4 F"])
def test_pan_is_masked_and_uppercased(spoken):
    assert mask_sensitive(f"pan {spoken}.") == "pan XXXXXX234F."


def test_full_number_never_survives():
    out = mask_sensitive("234567891234 and ABCDE1234F")
    assert "23456789" not in out and "ABCDE" not in out


def test_ordinary_numbers_are_left_alone():
    plain = "call 9876543210 about rupees 500 at 3.30, order 12345 on 2026-09-28"
    assert mask_sensitive(plain) == plain


def test_phone_with_plus_country_code_is_left_alone():
    assert mask_sensitive("reach me at +919876543210") == "reach me at +919876543210"


def test_longer_digit_runs_are_not_half_masked_as_aadhaar():
    card = "4111111111111111"
    assert mask_sensitive(card) == card


def test_words_that_look_like_pan_are_left_alone():
    assert mask_sensitive("ABCDE is not one, nor is ABCDEF1234G") == (
        "ABCDE is not one, nor is ABCDEF1234G"
    )


def test_empty_and_plain_text():
    assert mask_sensitive("") == ""
    assert mask_sensitive("Hello, how can I help?") == "Hello, how can I help?"
