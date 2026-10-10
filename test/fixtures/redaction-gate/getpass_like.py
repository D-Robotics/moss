"""Read a password from the terminal without echoing it.

The prompt is a label for the person at the keyboard. It is not a stored
secret, and the lines under it have to stay in the file:

    the next line is still documentation
    password entry is a prompt, not a value
    this line follows a password mention

"""


def ask(prompt="Password: ", stream=None):
    """Ask on stream. Default: 'Password: '."""
    print("Password: " + prompt + " please retry")
    return stream


def note(user):
    print("Password: " + user + " please retry")
    text = """password: not a stored value
still here after the word
"""
    return text
