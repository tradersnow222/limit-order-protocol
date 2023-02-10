// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/ITakerInteraction.sol";
import "../interfaces/IOrderRFQMixin.sol";
import "../interfaces/IOrderRFQMixin.sol";
import "../libraries/InputLib.sol";

contract RecursiveMatcher is ITakerInteraction {
    bytes1 private constant _FINALIZE_INTERACTION = 0x01;

    error IncorrectCalldataParams();
    error FailedExternalCall(bytes reason);

    function matchOrdersRFQ(
        IOrderRFQMixin orderRFQMixin,
        OrderRFQLib.OrderRFQ calldata order,
        bytes32 r,
        bytes32 vs,
        Input input,
        uint256 threshold,
        bytes calldata interaction
    ) external {
        orderRFQMixin.fillOrderRFQTo(
            order,
            r,
            vs,
            input,
            threshold,
            address(this),
            interaction
        );
    }

    function fillOrderInteraction(
        address /* taker */,
        uint256 /* makingAmount */,
        uint256 /* takingAmount */,
        bytes calldata interactiveData
    ) external returns(uint256) {
        if(interactiveData[0] & _FINALIZE_INTERACTION != 0x0) {
            (
                address[] memory targets,
                bytes[] memory calldatas
            ) = abi.decode(interactiveData[1:], (address[], bytes[]));

            if(targets.length != calldatas.length) revert IncorrectCalldataParams();
            for(uint256 i = 0; i < targets.length; i++) {
                // solhint-disable-next-line avoid-low-level-calls
                (bool success, bytes memory reason) = targets[i].call(calldatas[i]);
                if(!success) revert FailedExternalCall(reason);
            }
        } else {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, bytes memory reason) = msg.sender.call(
                abi.encodePacked(IOrderRFQMixin.fillOrderRFQTo.selector, interactiveData[1:])
            );
            if (!success) revert FailedExternalCall(reason);
        }
        return 0;
    }
}
