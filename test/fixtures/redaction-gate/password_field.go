package sample

// Password is a struct field name, not a stored secret.
type Login struct {
	Password string
	Token    string
}

func (l Login) ready(machine, login string) bool {
	return machine != "" && login != "" && l.password != ""
}
