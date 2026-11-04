package app

import "example.com/shop/storage"

type UpdateRequest struct {
	User struct {
		Name storage.Optional[string]
	}
}

func Apply(value interface{}) bool {
	request := value.(UpdateRequest)
	request.User.Name.Clear()
	return request.User.Name.IsSet()
}
