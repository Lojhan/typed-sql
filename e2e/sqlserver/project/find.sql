SELECT o.id,o.user_id,u.email,o.amount FROM dbo.orders AS o JOIN dbo.users AS u ON u.id=o.user_id WHERE o.id=:orderId
